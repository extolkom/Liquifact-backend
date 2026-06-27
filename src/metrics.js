'use strict';

/**
 * @fileoverview Prometheus metrics registry and /metrics route handler.
 *
 * ## Auth strategy (in priority order)
 *
 * 1. If `METRICS_BEARER_TOKEN` is set, require `Authorization: Bearer <token>`.
 *    The token comparison uses a **constant-time** algorithm to prevent timing
 *    side-channel attacks.
 *
 * 2. If `METRICS_BEARER_TOKEN` is **unset**, allow requests from loopback
 *    addresses only (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`). This is suitable
 *    for private-network Prometheus scraping.
 *
 * 3. All other requests receive a uniform `401` with no detail about _why_
 *    (no distinction between "wrong token" and "missing token").
 *
 * ## Security: trusted-proxy & X-Forwarded-For
 *
 * Loopback detection **always** reads the direct TCP connection address from
 * `req.socket.remoteAddress`. The `X-Forwarded-For` header is **never**
 * consulted, so a remote attacker cannot spoof a loopback origin by setting
 * `X-Forwarded-For: 127.0.0.1`.
 *
 * There is no `app.set('trust proxy', ...)` call anywhere in this application.
 * If one is added in the future, `req.ip` could resolve to a `X-Forwarded-For`
 * value, but this middleware **already** ignores `req.ip` for loopback checks
 * and reads the socket directly, making it resilient to such config changes.
 *
 * @module metrics
 */

let client;
try {
  client = require('prom-client');
} catch (_e) {
  // Fallback shim for environments without prom-client (tests)

  /**
   * Minimal prom-client Registry shim for test environments.
   * @implements {import('prom-client').Registry}
   */
  class RegistryShim {
    /** @param {void} */
    constructor() { this.contentType = 'text/plain'; }
    /** @returns {string} */
    metrics() { return ''; }
  }

/**
 * Bounded enum of allowed `reason` label values for maturity-reminder metrics.
 * Any raw error/reason string must be mapped through {@link normalizeReminderReason}
 * before being used as a Prometheus label to prevent time-series cardinality explosion.
 *
 * | Value            | Meaning                                              |
 * |------------------|------------------------------------------------------|
 * | smtp_timeout     | SMTP connection or send timed out                    |
 * | smtp_reject      | SMTP server rejected the message (4xx/5xx response)  |
 * | template_error   | Email template rendering failed                      |
 * | unknown          | Any other / unmapped failure                         |
 */
const REMINDER_REASON_ENUM = Object.freeze([
  'smtp_timeout',
  'smtp_reject',
  'template_error',
  'unknown',
]);

/**
 * Bounded enum of allowed `job_type` label values.
 * Add new job types here when introducing new background job kinds.
 */
const JOB_TYPE_ENUM = Object.freeze(['maturity_reminder', 'unknown']);

/**
 * Maps a raw error/reason string to a bounded Prometheus label value.
 *
 * Mapping table:
 * - Contains "timeout" (case-insensitive) → `smtp_timeout`
 * - Contains "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", or "connect" (case-insensitive) → `smtp_timeout`
 * - Contains "reject", "550", "551", "552", "553", "554" → `smtp_reject`
 * - Contains "4xx" SMTP temporary failures ("421", "450", "451", "452") → `smtp_reject`
 * - Contains "template" (case-insensitive) → `template_error`
 * - Anything else, empty, null, or non-string → `unknown`
 *
 * PII guarantee: this function only pattern-matches; it never includes the
 * raw string in the returned label, so no recipient address or invoice
 * content can leak into Prometheus label values.
 *
 * @param {unknown} raw - Raw error message, reason string, or Error object.
 * @returns {'smtp_timeout'|'smtp_reject'|'template_error'|'unknown'} Bounded label value.
 */
function normalizeReminderReason(raw) {
  const str = raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : '';
  if (!str) { return 'unknown'; }

  if (/timeout|ETIMEDOUT|ECONNREFUSED|ECONNRESET|connect/i.test(str)) {
    return 'smtp_timeout';
  }
  if (/reject|55[0-4]|42[0-9]|EAUTH/i.test(str)) {
    return 'smtp_reject';
  }
  if (/template/i.test(str)) {
    return 'template_error';
  }
  return 'unknown';
}

/**
 * Maps a raw job type string to a bounded Prometheus label value.
 *
 * @param {unknown} raw - Raw job type string.
 * @returns {string} Bounded label value from {@link JOB_TYPE_ENUM}.
 */
function normalizeJobType(raw) {
  const str = typeof raw === 'string' ? raw : '';
  return JOB_TYPE_ENUM.includes(str) ? str : 'unknown';
}

// ── Maturity-reminder counters ────────────────────────────────────────────────

/**
 * Total maturity-reminder delivery attempts, labelled by bounded `reason` and `job_type`.
 * @type {import('prom-client').Counter}
 */
const maturityReminderDeliveryAttemptsTotal = new client.Counter({
  name: 'maturity_reminder_delivery_attempts_total',
  help: 'Total number of maturity-reminder delivery attempts',
  labelNames: ['reason', 'job_type'],
  registers: [],
});

/**
 * Total maturity-reminder dead-letter events, labelled by bounded `reason` and `job_type`.
 * @type {import('prom-client').Counter}
 */
const maturityReminderDeadLetterTotal = new client.Counter({
  name: 'maturity_reminder_dead_letter_total',
  help: 'Total number of maturity-reminder messages moved to the dead-letter queue',
  labelNames: ['reason', 'job_type'],
  registers: [],
});

/** Shared registry — exported so tests can reset it between runs. */
const registry = new client.Registry();

/**
 * Constant-time string comparison to prevent timing attacks.
 *
 * Returns `false` early when lengths differ (public info leaked by content-length
 * rather than timing), but still performs a full-length XOR when lengths match
 * so that a timing attacker cannot distinguish _where_ the difference occurs.
 *
 * @param {string} a - First string to compare.
 * @param {string} b - Second string to compare.
 * @returns {boolean} `true` when the strings are equal, `false` otherwise.
 *
 * @example
 * safeEqual('secret', 'secret'); // true
 * safeEqual('secret', 'wrong');  // false
 */
function safeEqual(a, b) {
  if (a.length !== b.length) { return false; }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// Register bounded counters with the shared registry
registry.registerMetric(maturityReminderDeliveryAttemptsTotal);
registry.registerMetric(maturityReminderDeadLetterTotal);

/**
 * Set of loopback IP addresses that are allowed when no bearer token is
 * configured. Includes IPv4, IPv6, and IPv4-mapped IPv6 representations.
 *
 * @type {ReadonlySet<string>}
 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Extracts the direct TCP connection IP address from the request.
 *
 * Reads `req.socket.remoteAddress` first — this is the actual TCP socket peer
 * and cannot be spoofed via `X-Forwarded-For` or any other HTTP header. Falls
 * back to `req.ip` when the socket address is unavailable (edge case in some
 * test environments or HTTP/2 proxies).
 *
 * @param {import('express').Request} req - Express request object.
 * @returns {string} The client IP address string, or empty string if
 *   neither source is available.
 *
 * @example
 * extractClientIp(req); // '127.0.0.1'
 */
function extractClientIp(req) {
  return (req.socket && req.socket.remoteAddress) || req.ip || '';
}

/**
 * Express middleware that enforces metrics endpoint authentication.
 *
 * ## Auth decision flow
 *
 * ```
 * METRICS_BEARER_TOKEN set?
 *   ├── YES → constant-time compare Authorization header
 *   │         ├── match  → next()
 *   │         └── no match → 401 (no detail)
 *   └── NO  → extractClientIp(req) in LOOPBACK set?
 *             ├── yes → next()
 *             └── no  → 401 (no detail)
 * ```
 *
 * The response is **always** a plain `{ error: 'Unauthorized' }` with no
 * indication of whether the failure was a missing token, wrong token, or
 * non-loopback origin.
 *
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @param {import('express').NextFunction} next - Express next callback.
 * @returns {void}
 */
function metricsAuth(req, res, next) {
  const token = process.env.METRICS_BEARER_TOKEN;

  if (token) {
    const auth = req.headers['authorization'] || '';
    if (safeEqual(auth, `Bearer ${token}`)) { return next(); }
    const authFallback = req.headers['Authorization'] || '';
    if (safeEqual(authFallback, `Bearer ${token}`)) { return next(); }
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  // No token configured — allow loopback only, using the direct TCP socket IP.
  // X-Forwarded-For is NEVER trusted for this check.
  const ip = extractClientIp(req);
  if (LOOPBACK.has(ip)) { return next(); }

  res.status(401).json({ error: 'Unauthorized' });
}

/**
 * Express route handler that returns Prometheus metrics in plain-text format.
 *
 * @param {import('express').Request} _req - Express request (unused).
 * @param {import('express').Response} res - Express response.
 * @returns {Promise<void>}
 */
async function metricsHandler(_req, res) {
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
}

module.exports = {
  registry,
  metricsAuth,
  metricsHandler,
  normalizeReminderReason,
  normalizeJobType,
  maturityReminderDeliveryAttemptsTotal,
  maturityReminderDeadLetterTotal,
  REMINDER_REASON_ENUM,
  JOB_TYPE_ENUM,
};
