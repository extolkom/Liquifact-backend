/**
 * src/services/investorCommitment.js
 *
 * Persists investor commitment records produced by the fund-invoice flow.
 * Uses Knex (the project's existing query builder) so the implementation works
 * with both PostgreSQL (production) and SQLite (test/CI).
 *
 * Table: investor_commitments
 * Schema is created by migration: migrations/YYYYMMDDHHII_create_investor_commitments.js
 *
 * Idempotency: callers may supply an idempotencyKey (e.g. sha256 of
 * investor + invoiceId + amount). Duplicate submissions with the same key
 * return the existing row rather than inserting a second one.
 */

'use strict';

const db = require('../db/knex');
const { getSharedStore } = require('./cacheStore');
const { invalidatePrefix } = require('../middleware/cache');

const TABLE = 'investor_commitments';

/**
 * @typedef {Object} CommitmentRecord
 * @property {string}  id
 * @property {string}  invoice_id
 * @property {string}  investor_address
 * @property {string}  escrow_address
 * @property {string}  amount_stroops      — integer string
 * @property {'requires_signature'|'submitted'|'stubbed'} status
 * @property {string|null} unsigned_xdr
 * @property {string|null} tx_hash
 * @property {string|null} ledger
 * @property {string|null} idempotency_key
 * @property {Date}    created_at
 * @property {Date}    updated_at
 */

/**
 * Persist a new commitment, or return the existing one when the idempotency
 * key matches a prior row.
 *
 * @param {Object} params
 * @param {string} params.invoiceId
 * @param {string} params.investorAddress
 * @param {string} params.escrowAddress
 * @param {string|number} params.amountStroops
 * @param {'requires_signature'|'submitted'|'stubbed'} params.status
 * @param {string|null} [params.unsignedXdr]
 * @param {string|null} [params.txHash]
 * @param {string|null} [params.ledger]
 * @param {string|null} [params.idempotencyKey]
 * @returns {Promise<CommitmentRecord>}
 */
async function persistCommitment({
  invoiceId,
  investorAddress,
  escrowAddress,
  amountStroops,
  status,
  unsignedXdr = null,
  txHash = null,
  ledger = null,
  idempotencyKey = null,
}) {
  // Idempotency check: return early if we've already processed this exact request
  if (idempotencyKey) {
    const existing = await db(TABLE).where({ idempotency_key: idempotencyKey }).first();
    if (existing) {
      return existing;
    }
  }

  const [row] = await db(TABLE)
    .insert({
      invoice_id: invoiceId,
      investor_address: investorAddress,
      escrow_address: escrowAddress,
      amount_stroops: String(amountStroops),
      status,
      unsigned_xdr: unsignedXdr,
      tx_hash: txHash,
      ledger,
      idempotency_key: idempotencyKey,
    })
    .returning('*');

  return row;
}

/**
 * Update the status of an existing commitment (e.g. once the investor submits
 * the signed XDR and we observe the ledger result).
 *
 * @param {string} id        — commitment UUID
 * @param {Partial<CommitmentRecord>} fields
 * @returns {Promise<CommitmentRecord>}
 */
async function updateCommitment(id, fields) {
  const [row] = await db(TABLE)
    .where({ id })
    .update({ ...fields, updated_at: db.fn.now() })
    .returning('*');
  if (!row) {
    throw new Error(`Commitment not found: ${id}`);
  }
  return row;
}

  /**
   * Find commitments for a given investor and invoice.
   *
   * @param {string} investorAddress
   * @param {string} invoiceId
   * @returns {Promise<CommitmentRecord[]>}
   */
  async function findCommitments(investorAddress, invoiceId) {
    return db(TABLE).where({ investor_address: investorAddress, invoice_id: invoiceId }).orderBy('created_at', 'desc');
  }

  // ── In-memory lock helpers (used by investor route and tests) ──────────────

  /**
   * Validates a Stellar public key (G... or C... 56-char format).
   *
   * @param {string} address
   * @returns {{ valid: boolean, reason?: string }}
   */
  function validateAddress(address) {
    if (typeof address !== 'string' || address.trim() === '') {
      return { valid: false, reason: 'address must be a non-empty string' };
    }
    const trimmed = address.trim();
    if (!/^[GC][A-Z0-9]{55}$/.test(trimmed)) {
      return {
        valid: false,
        reason: 'invalid Stellar address format (expected G... or C... with 56 chars)',
      };
    }
    return { valid: true };
  }

  const investorLocks = [];

  /**
   * Creates or updates an in-memory lock record.
   *
   * @param {object} lock
   * @param {string} lock.funderAddress
   * @param {string} lock.claimNotBefore
   * @param {number} lock.investorEffectiveYieldBps
   * @param {string} lock.invoiceId
   * @returns {object} The stored lock record.
   */
  function setInvestorLock({ funderAddress, claimNotBefore, investorEffectiveYieldBps, invoiceId }) {
    const existingIndex = investorLocks.findIndex(
      (l) => l.funderAddress === funderAddress && l.invoiceId === invoiceId,
    );

    const lock = {
      funderAddress,
      claimNotBefore,
      investorEffectiveYieldBps,
      invoiceId,
      stale: true,
      updatedAt: new Date().toISOString(),
    };

    if (existingIndex >= 0) {
      investorLocks[existingIndex] = lock;
    } else {
      investorLocks.push(lock);
    }

    return lock;
  }

  /**
   * Returns locks for a given funder address, optionally filtered by invoiceId.
   *
   * @param {string} funderAddress
   * @param {{ invoiceId?: string }} [options]
   * @returns {object[]}
   */
  function getInvestorLocksByAddress(funderAddress, options) {
    const { invoiceId } = options || {};
    let locks = investorLocks.filter((l) => l.funderAddress === funderAddress);
    if (invoiceId) {
      locks = locks.filter((l) => l.invoiceId === invoiceId);
    }
    return locks;
  }

  /**
   * Returns all locks, optionally filtered by invoiceId.
   *
   * @param {{ invoiceId?: string }} [options]
   * @returns {object[]}
   */
  function getAllInvestorLocks(options) {
    const { invoiceId } = options || {};
    if (invoiceId) {
      return investorLocks.filter((l) => l.invoiceId === invoiceId);
    }
    return [...investorLocks];
  }

  /**
   * Returns a single lock by invoice ID and funder address.
   *
   * @param {string} invoiceId
   * @param {string} funderAddress
   * @returns {object|undefined}
   */
  function getInvestorLock(invoiceId, funderAddress) {
    return investorLocks.find((l) => l.invoiceId === invoiceId && l.funderAddress === funderAddress);
  }

  /**
   * Removes all in-memory lock records (test helper).
   *
   * @returns {void}
   */
  function clearInvestorLocks() {
    investorLocks.length = 0;
  }

  /**
   * Seeds sample lock records (test helper).
   *
   * @returns {void}
   */
  function seedInvestorLocks() {
    const samples = [
      {
        funderAddress: 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOUJ3LNLRK',
        claimNotBefore: '2026-01-01T00:00:00Z',
        investorEffectiveYieldBps: 850,
        invoiceId: 'inv_7788',
      },
      {
        funderAddress: 'GDGQVOKHW4VEJRU2TETD8G6RWJ3TVM3VROMV7I3ESNITIBLL6QL6RAIL',
        claimNotBefore: '2026-02-01T00:00:00Z',
        investorEffectiveYieldBps: 700,
        invoiceId: 'inv_2244',
      },
    ];
    samples.forEach((s) => setInvestorLock(s));
  }

  // ── Cache invalidation wrappers ────────────────────────────────────────────

  /**
   * Persists a commitment and invalidates the investor locks cache.
   *
   * @param {Object} params - Same as {@link persistCommitment}.
   * @returns {Promise<CommitmentRecord>} The persisted commitment record.
   */
  async function persistCommitmentAndInvalidate(params) {
    const result = await persistCommitment(params);
    invalidatePrefix(getSharedStore(), 'investor:');
    return result;
  }

  /**
   * Updates a commitment and invalidates the investor locks cache.
   *
   * @param {string} id - Commitment UUID.
   * @param {Partial<CommitmentRecord>} fields - Fields to update.
   * @returns {Promise<CommitmentRecord>} The updated commitment record.
   */
  async function updateCommitmentAndInvalidate(id, fields) {
    const result = await updateCommitment(id, fields);
    invalidatePrefix(getSharedStore(), 'investor:');
    return result;
  }

  module.exports = {
    persistCommitment: persistCommitmentAndInvalidate,
    updateCommitment: updateCommitmentAndInvalidate,
    findCommitments,
    validateAddress,
    setInvestorLock,
    getInvestorLocksByAddress,
    getAllInvestorLocks,
    getInvestorLock,
    clearInvestorLocks,
    seedInvestorLocks,
  };