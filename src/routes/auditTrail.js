'use strict';

/**
 * @fileoverview Admin routes for invoice audit trail and state-transition history export.
 * All routes require admin authentication (JWT or API key) and tenant isolation.
 *
 * Routes:
 *   GET /api/admin/audit/invoices/:invoiceId        - Paginated audit trail
 *   GET /api/admin/audit/invoices/:invoiceId/transitions - State-transition history
 *   GET /api/admin/audit/invoices/:invoiceId/export  - Export as JSON or CSV
 *
 * @module routes/auditTrail
 */

const express = require('express');
const router = express.Router();
const { adminStack } = require('../middleware/stacks');
const { getInvoiceAuditTrail, countAuditLogs, exportInvoiceAuditLogs, getAuditLogs } = require('../services/auditLog');
const { streamAuditEvents, createCsvTransform } = require('../services/auditLogStore');
const { getTransitionHistory } = require('../services/invoiceStateMachine');
const AppError = require('../errors/AppError');

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;

// ── Middleware stack for all routes ──────────────────────────────────────────
router.use(...adminStack);

/**
 * Parse and clamp pagination params from query string.
 * @param {object} query
 * @returns {{ limit: number, offset: number }}
 */
function parsePagination(query) {
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(parseInt(query.offset, 10) || 0, 0);
  return { limit, offset };
}

/**
 * Validate invoiceId path param — reject obviously malformed values.
 * @param {string} invoiceId
 * @returns {boolean}
 */
function isValidInvoiceId(invoiceId) {
  return typeof invoiceId === 'string' && invoiceId.length > 0 && invoiceId.length <= 128;
}

/**
 * GET /api/admin/audit/invoices/:invoiceId
 * Returns paginated audit trail for a specific invoice.
 * Tenant-scoped: only returns records matching req.tenantId.
 */
router.get('/invoices/:invoiceId', (req, res, next) => {
  try {
    const { invoiceId } = req.params;
    if (!isValidInvoiceId(invoiceId)) {
      return next(new AppError({
        type: 'https://liquifact.com/probs/validation-error',
        title: 'Validation Error',
        status: 400,
        detail: 'Invalid invoiceId.',
      }));
    }

    const { limit, offset } = parsePagination(req.query);
    const logs = getInvoiceAuditTrail(invoiceId, limit, offset, req.tenantId);
    const total = countAuditLogs({ resourceId: invoiceId, resourceType: 'invoice', tenantId: req.tenantId });

    return res.json({
      data: logs,
      meta: { invoiceId, limit, offset, total },
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/admin/audit/invoices/:invoiceId/transitions
 * Returns state-transition history for a specific invoice.
 */
router.get('/invoices/:invoiceId/transitions', (req, res, next) => {
  try {
    const { invoiceId } = req.params;
    if (!isValidInvoiceId(invoiceId)) {
      return next(new AppError({
        type: 'https://liquifact.com/probs/validation-error',
        title: 'Validation Error',
        status: 400,
        detail: 'Invalid invoiceId.',
      }));
    }

    const transitions = getTransitionHistory(invoiceId, (opts) =>
      getAuditLogs({ ...opts, tenantId: req.tenantId })
    );

    return res.json({ data: transitions, meta: { invoiceId } });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/admin/audit/invoices/:invoiceId/export
 * Exports audit trail as JSON or streaming CSV.
 *
 * Query params:
 *   format  - 'json' (default) | 'csv'
 *   limit   - max rows for JSON export (ignored for CSV streaming)
 *
 * CSV export behaviour:
 *   - Rows are streamed from the database cursor and piped directly into
 *     the HTTP response; the full result set is never buffered in memory.
 *   - Each field is formula-injection-safe (cells beginning with =, +,
 *     -, @ are prefixed with a single quote).
 *   - Tenant isolation is enforced at the database level via the JSONB
 *     `metadata->>'tenantId'` filter on every streamed row.
 */
router.get('/invoices/:invoiceId/export', (req, res, next) => {
  const { invoiceId } = req.params;
  if (!isValidInvoiceId(invoiceId)) {
    return next(new AppError({
      type: 'https://liquifact.com/probs/validation-error',
      title: 'Validation Error',
      status: 400,
      detail: 'Invalid invoiceId.',
    }));
  }

  const format = req.query.format === 'csv' ? 'csv' : 'json';

  // ── JSON export (unchanged, buffered) ────────────────────────────────────
  if (format !== 'csv') {
    const { limit } = parsePagination(req.query);
    return exportInvoiceAuditLogs({ invoiceId, limit, format: 'json', tenantId: req.tenantId })
      .then((output) => {
        res.set('Content-Type', 'application/json');
        res.send(output);
      })
      .catch(next);
  }

  // ── CSV streaming export ─────────────────────────────────────────────────
  res.set('Content-Type', 'text/csv');
  res.set(
    'Content-Disposition',
    `attachment; filename="audit-${invoiceId}.csv"`
  );

  const dbStream = streamAuditEvents({
    targetId: invoiceId,
    targetType: 'invoice',
    tenantId: req.tenantId,
  });

  const csvTransform = createCsvTransform();

  // Forward any stream errors to Express so the error handler can log
  // them; by this point headers may already be flushed, but we at least
  // abort cleanly and avoid leaving the response hanging.
  dbStream.on('error', (err) => {
    csvTransform.destroy(err);
    next(err);
  });

  csvTransform.on('error', (err) => {
    res.destroy();
    next(err);
  });

  dbStream.pipe(csvTransform).pipe(res);
});

module.exports = router;
