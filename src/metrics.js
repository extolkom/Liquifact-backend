'use strict';

/**
 * @fileoverview Prometheus metrics registry and /metrics route handler.
 *
 * Auth strategy (in priority order):
 *   1. If METRICS_BEARER_TOKEN is set, require `Authorization: Bearer <token>`.
 *   2. If METRICS_BEARER_TOKEN is unset, allow requests from loopback only
 *      (127.0.0.1, ::1, ::ffff:127.0.0.1) — suitable for private-network scraping.
 *   3. All other requests receive 401.
 *
 * @module metrics
 */

const client = require('prom-client');

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

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

client.collectDefaultMetrics({ register: registry });

// Register bounded counters with the shared registry
registry.registerMetric(maturityReminderDeliveryAttemptsTotal);
registry.registerMetric(maturityReminderDeadLetterTotal);

/**
 * Express middleware that enforces metrics auth.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {void}
 */
function metricsAuth(req, res, next) {
  const token = process.env.METRICS_BEARER_TOKEN;

  if (token) {
    const auth = req.headers['authorization'] || '';
    if (auth === `Bearer ${token}`) {return next();}
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  // No token configured — allow loopback only
  const ip = req.ip || req.socket.remoteAddress || '';
  if (LOOPBACK.has(ip)) {return next();}

  res.status(401).json({ error: 'Unauthorized' });
}

/**
 * Express route handler that returns Prometheus metrics.
 *
 * @param {import('express').Request} _req
 * @param {import('express').Response} res
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
