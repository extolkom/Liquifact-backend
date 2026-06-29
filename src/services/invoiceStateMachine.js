'use strict';

/**
 * Canonical invoice status vocabulary shared by invoice-list and marketplace
 * query validators.
 */

/**
 * Lifecycle states used by invoice transition endpoints.
 * @type {Readonly<Record<string, string>>}
 */
const INVOICE_STATES = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  LINKED_ESCROW: 'linked_escrow',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
});

/**
 * Legacy payment-facing statuses accepted by GET /api/invoices.
 * @type {readonly string[]}
 */
const PAYMENT_STATUSES = Object.freeze(['paid', 'pending', 'overdue']);

/**
 * Funding and settlement statuses surfaced by marketplace and escrow flows.
 * @type {readonly string[]}
 */
const FUNDING_PROGRESS_STATUSES = Object.freeze([
  'pending_verification',
  'verified',
  'partially_funded',
  'funded',
  'settled',
  'completed',
  'defaulted',
]);

/**
 * Authoritative invoice status list for query-parameter validation.
 * @type {readonly string[]}
 */
const ALL_INVOICE_STATUSES = Object.freeze([
  ...new Set([
    ...PAYMENT_STATUSES,
    ...FUNDING_PROGRESS_STATUSES,
    ...Object.values(INVOICE_STATES),
  ]),
]);

/**
 * Statuses visible in public investable invoice flows.
 * @type {readonly string[]}
 */
const INVESTABLE_STATUSES = Object.freeze(['verified', 'partially_funded']);

/**
 * Terminal states that should not become investable.
 * @type {readonly string[]}
 */
const TERMINAL_STATES = Object.freeze([
  INVOICE_STATES.LINKED_ESCROW,
  INVOICE_STATES.REJECTED,
  INVOICE_STATES.CANCELLED,
  'completed',
  'defaulted',
  'settled',
]);

/**
 * Authoritative set of invoice states that involve capital movement.
 * Any state included in this set automatically triggers KYC gating.
 * @type {Set<string>}
 */
const CAPITAL_MOVING_STATES = new Set(['funded', 'settled']);

module.exports = {
  INVOICE_STATES,
  ALL_INVOICE_STATUSES,
  INVESTABLE_STATUSES,
  TERMINAL_STATES,
  CAPITAL_MOVING_STATES,
};
