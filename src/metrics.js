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
const crypto = require('crypto');

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Shared registry — exported so tests can reset it between runs. */
const registry = new client.Registry();

client.collectDefaultMetrics({ register: registry });

/**
 * Counter for escrow reconciliation mismatches detected between the DB
 * `fundedTotal` and the on-chain `funded_amount`.
 *
 * Incremented once per invoice whose reconciliation status resolves to
 * `mismatch`. Use `rate(escrow_reconciliation_mismatches_total[1d])` to alert
 * on drift appearing between nightly runs.
 *
 * @type {import('prom-client').Counter<string>}
 */
const escrowReconciliationMismatches = new client.Counter({
  name: 'escrow_reconciliation_mismatches_total',
  help: 'Total escrow reconciliation mismatches between DB fundedTotal and on-chain funded_amount',
  registers: [registry],
});

/**
 * Constant-time string equality check to avoid leaking the secret via timing.
 *
 * Returns `false` immediately for non-strings or length mismatches (length is
 * not itself secret here) and otherwise compares with `crypto.timingSafeEqual`.
 *
 * @param {string} a - First value.
 * @param {string} b - Second value.
 * @returns {boolean} True when the two strings are byte-for-byte equal.
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

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
    if (safeEqual(auth, `Bearer ${token}`)) {return next();}
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

module.exports = { registry, metricsAuth, metricsHandler, escrowReconciliationMismatches };
