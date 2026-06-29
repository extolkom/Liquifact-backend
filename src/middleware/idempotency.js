'use strict';

/**
 * Idempotency middleware for POST /api/invest/fund-invoice and escrow
 * funding submissions.
 *
 * Accepts an `Idempotency-Key` header validated against the existing
 * IDEMPOTENCY_KEY_PATTERN from escrowSubmit.js.  Stores key →
 * (request fingerprint, status, response) with a TTL in the
 * `idempotency_keys` table.  Returns the cached response on duplicate
 * keys; returns 409 when the same key is reused with a different request
 * body fingerprint.
 *
 * Security:
 *  - Keys are validated against a strict pattern before any DB access.
 *  - Request body is hashed (SHA-256) before storage — no raw payload
 *    is persisted.
 *  - Keys expire after a configurable TTL (default 24 h) and the
 *    middleware itself purges expired rows on lookup so a stale, un-purged
 *    row never causes a stale replay or a spurious 409.
 *  - In-flight placeholders are bounded by ORPHAN_IN_FLIGHT_TIMEOUT_MS so
 *    a handler crash or process restart cannot leave a key permanently
 *    locked until the retention TTL expires.
 */

const crypto = require('crypto');
const { IDEMPOTENCY_KEY_PATTERN } = require('../services/escrowSubmit');
const db = require('../db/knex');
const { createProblemDetails, LIQUifact_PROBLEM_BASE } = require('./problemJson');

const DEFAULT_TTL_HOURS = 24;

/**
 * Maximum age (ms) of a non-completed placeholder before it is treated as
 * an orphaned in-flight lock and removed. Bounded so a handler crash or
 * process restart cannot lock a key for the full retention TTL.
 * Configurable via IDEMPOTENCY_ORPHAN_TIMEOUT_MS (must be >= 1000 ms).
 */
const ORPHAN_IN_FLIGHT_TIMEOUT_MS = (() => {
  const raw = parseInt(process.env.IDEMPOTENCY_ORPHAN_TIMEOUT_MS || '', 10);
  return Number.isFinite(raw) && raw >= 1000 ? raw : 120000;
})();

/**
 * Get TTL in hours from env or default.
 * @returns {number}
 */
function getTTLHours() {
  const raw = process.env.IDEMPOTENCY_KEY_TTL_HOURS;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_HOURS;
}

/**
 * Compute a SHA-256 fingerprint of the request body for conflict detection.
 * @param {object} body
 * @returns {string}
 */
function fingerprint(body) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(body), 'utf8')
    .digest('hex');
}

/**
 * Build an RFC 7807 problem+json body for an idempotency-key conflict.
 * @param {object} req - Express request (for request-id correlation)
 * @param {string} detail - Human-readable reason
 * @returns {object}
 */
function buildConflict(req, detail) {
  return createProblemDetails({
    type: `${LIQUifact_PROBLEM_BASE || 'https://liquifact.com/probs'}/conflict`,
    title: 'Conflict',
    status: 409,
    detail,
    requestId: req.id || req.headers['x-request-id'] || 'unknown',
  });
}

/**
 * Express middleware enforcing idempotency on funding submissions.
 *
 * Behaviour:
 *  1. Missing `Idempotency-Key` header → 400 (no DB access)
 *  2. Malformed `Idempotency-Key` → 400 (no DB access)
 *  3. Inside a transaction:
 *     a. If an existing row is past its retention TTL, delete it so a
 *        fresh request is allowed (defensive backstop; the background
 *        purge job is authoritative).
 *     b. If an existing row is a placeholder (response_status null) AND
 *        it has been unfilled for more than
 *        ORPHAN_IN_FLIGHT_TIMEOUT_MS, delete it (orphan recovery).
 *     c. If a non-orphan placeholder exists for the same fingerprint,
 *        return 409 ("currently being processed") to prevent double
 *        funding. Caller may safely retry after completion or after the
 *        orphan timeout.
 *     d. If a completed response exists for the same fingerprint, replay
 *        it.
 *     e. If a row exists for a DIFFERENT fingerprint, return 409.
 *     f. Otherwise insert a placeholder, override res.json to capture
 *        the response for future replays, and call next().
 *  4. On response capture, UPDATE the row with the final status & body
 *     using the global `db` handle (NOT `trx` — the surrounding tx has
 *     already committed by the time the handler runs).
 *
 * @param {object} req - Express request
 * @param {object} res - Express response
 * @param {function} next - Express next callback
 * @returns {void}
 */
function idempotencyMiddleware(req, res, next) {
  const key = req.header('Idempotency-Key');
  if (!key) {
    return res.status(400).json({
      success: false,
      error: 'Idempotency-Key header is required for this endpoint.',
    });
  }

  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    return res.status(400).json({
      success: false,
      error:
        'Idempotency-Key must be 8–128 URL-safe characters (A-Za-z0-9._:-).',
    });
  }

  const bodyFingerprint = fingerprint(req.body);
  const ttlHours = getTTLHours();
  // Store as an explicit ISO 8601 string. Knex + SQLite + node-sqlite3 may
  // serialise Date objects as numbers or non-ISO strings depending on column
  // affinity rules and the surrounding column definitions; an explicit ISO
  // string is the only format that round-trips parseably on both SQLite and
  // PostgreSQL.
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();

  db.transaction(async (trx) => {
    const now = new Date();
    let existing = await trx('idempotency_keys')
      .where({ idempotency_key: key })
      .first();

    // Retention TTL backstop: purge expired rows so a stale record never
    // causes a stale replay or a spurious 409. Authoritative cleanup is
    // the background purge job; this is a defensive in-line step.
    if (
      existing &&
      new Date(String(existing.expires_at)).getTime() <= now.getTime()
    ) {
      await trx('idempotency_keys').where({ idempotency_key: key }).del();
      existing = null;
    }

    // Orphan in-flight recovery: a placeholder whose handler crashed,
    // timed out, or whose process restarted mid-flight would otherwise
    // remain stuck with response_status=null for the entire retention
    // TTL, permanently 409-ing the same key. Bound the poison window.
    if (
      existing &&
      existing.response_status === null &&
      now.getTime() - new Date(String(existing.created_at)).getTime() >
        ORPHAN_IN_FLIGHT_TIMEOUT_MS
    ) {
      await trx('idempotency_keys').where({ idempotency_key: key }).del();
      existing = null;
    }

    if (existing) {
      // Same key — check fingerprint
      if (existing.request_fingerprint !== bodyFingerprint) {
        res.setHeader('Content-Type', 'application/problem+json');
        return res.status(409).json(
          buildConflict(
            req,
            'Idempotency-Key reused with a different request body. Use a unique key for each distinct payload.'
          )
        );
      }

      // In-flight: another concurrent request is processing this key but
      // has not yet stored the response. Returning 409 prevents the
      // second caller from running the funding handler twice — a
      // financially dangerous outcome. Caller may safely retry after
      // completion (response stored → replay) or after the orphan
      // timeout elapses (row cleared → fresh insert).
      if (existing.response_status === null) {
        res.setHeader('Content-Type', 'application/problem+json');
        return res.status(409).json(
          buildConflict(
            req,
            'Idempotency-Key is currently being processed. Retry after the original request completes.'
          )
        );
      }

      // Replay — return the original cached response
      const cached = existing.response_body;
      const status = existing.response_status || 201;
      try {
        const parsed = typeof cached === 'string' ? JSON.parse(cached) : cached;
        return res.status(status).json(parsed);
      } catch {
        return res.status(status).json(cached);
      }
    }

    // New key — insert placeholder
    await trx('idempotency_keys').insert({
      idempotency_key: key,
      request_fingerprint: bodyFingerprint,
      response_status: null,
      response_body: null,
      expires_at: expiresAt,
    });

    // Override res.json to capture the response for future replays.
    // IMPORTANT: use the global `db` (not `trx`) here. The surrounding
    // db.transaction() callback resolves immediately after next() — the
    // actual request handler runs asynchronously, AFTER the tx commits.
    // Calling `trx(...)` after commit throws "Transaction committed".
    const originalJson = res.json.bind(res);
    res.json = function (body) {
      // Fire-and-forget storage of the response payload for future replays.
      // Use a JS-computed ISO 8601 string for `updated_at` (rather than
      // `db.fn.now()`) so the value is consistently parseable across SQLite
      // (which may return non-ISO datetimes) and PostgreSQL.
      const updatedAt = new Date().toISOString();
      db('idempotency_keys')
        .where({ idempotency_key: key })
        .update({
          response_status: res.statusCode,
          response_body: JSON.stringify(body),
          updated_at: updatedAt,
        })
        .catch(() => {
          // Best-effort — don't fail the request if storage fails
        });

      return originalJson(body);
    };

    next();
  }).catch((err) => {
    // Transaction-level errors (e.g. DB unavailable)
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        error: 'Internal server error processing idempotency key.',
      });
    }
    // If headers already sent, the error happened post-response — log only
    console.error('[idempotency] Post-response storage error:', err.message);
  });
}

module.exports = idempotencyMiddleware;
