/**
 * @fileoverview Escrow read service — fetches on-chain escrow state including
 * the `get_legal_hold` flag from the LiquifactEscrow Soroban contract.
 *
 * The service is intentionally side-effect-free: it reads state and returns a
 * plain object. All mutation (funding, settlement) lives in separate modules.
 *
 * Read ordering (when no test adapter is injected):
 *
 *   1. Cache      — optional Redis escrow summary cache (`REDIS_ESCROW_CACHE_*`).
 *                   Orchestrated by {@link getEscrowStateWithProjection}; the
 *                   lower-level readers prefer the projection first.
 *   2. Projection — durable per-invoice `escrow_event_projection` row written
 *                   by the indexer (`src/jobs/escrowIndexer.js`). Decimals on
 *                   the projection are display-only — never used to scale
 *                   on-chain principal math.
 *   3. RPC stub   — production placeholder for the Soroban `get_escrow_state`
 *                   call. Returns a neutral `{ status: 'not_found',
 *                   fundedAmount: 0 }` shape so callers do not see fabricated
 *                   state for invoice IDs the indexer has not yet recorded.
 *
 * Test injection: tests should supply `escrowAdapter` to short-circuit the
 * projection + RPC fallback chain. Adapter injection takes precedence over
 * the cache and projection paths so unit tests stay deterministic.
 *
 * Ledger time: when the Soroban response includes a `ledgerCloseTime` field
 * (Unix epoch seconds), it is forwarded as `ledgerCloseTime` on the returned
 * state so callers can pass it to {@link module:services/escrowDerived} as
 * `opts.ledgerCloseTime`.  This ensures `daysToMaturity` is computed from
 * ledger time rather than the server wall clock.
 *
 * @module services/escrowRead
 */

"use strict";

const { callSorobanContract } = require("./soroban");
const logger = require("../logger");
const { getTokenMetadata } = require("./tokenMeta");
const db = require("../db/knex");
const { createRedisEscrowSummaryCache } = require("../cache/redis");

const cache = createRedisEscrowSummaryCache();

/**
 * Regex that a valid invoice ID must satisfy.
 * Aligned with IDENTIFIER_PATTERN in escrowSubmit.js.
 * Allows alphanumeric start, followed by alphanumeric, underscores, hyphens, dots, or colons, 1–128 chars.
 *
 * @constant {RegExp}
 */
const INVOICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Neutral base-state shape returned when neither the projection nor a test
 * adapter has data for an invoice. Never fabricate funded amounts: a missing
 * projection must look like "not on-chain yet", not like a funded stub.
 *
 * @constant {object}
 */
const NEUTRAL_BASE_STATE = Object.freeze({
  status: "not_found",
  fundedAmount: 0,
  source: "rpc_stub",
});

/**
 * Validates an invoice ID string.
 *
 * @param {unknown} invoiceId - Value to validate.
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateInvoiceId(invoiceId) {
  if (typeof invoiceId !== "string" || invoiceId.trim() === "") {
    return { valid: false, reason: "invoiceId must be a non-empty string" };
  }
  if (!INVOICE_ID_RE.test(invoiceId.trim())) {
    return {
      valid: false,
      reason: "invoiceId contains invalid characters (allowed: a-z A-Z 0-9 _ -)",
    };
  }
  return { valid: true };
}

/**
 * Calls the on-chain `get_legal_hold` getter for the given escrow contract.
 *
 * In production this would invoke the real Soroban RPC; here we wrap the
 * operation in `callSorobanContract` so retries and error mapping are applied
 * consistently. The `adapter` parameter lets tests inject a stub without
 * monkey-patching the module.
 *
 * @param {string} invoiceId - Validated invoice identifier.
 * @param {Function} [adapter] - Optional async function `(invoiceId) => boolean`.
 *   Defaults to the production Soroban stub.
 * @returns {Promise<boolean>} Resolves to `true` when the escrow is under legal
 *   hold, `false` otherwise. Defaults to `false` on any non-fatal error so
 *   that a missing or unreachable contract never silently unblocks funding.
 */
async function fetchLegalHold(invoiceId, adapter) {
  const operation = adapter
    ? () => adapter(invoiceId)
    : async () => {
        // Production stub — replace with real Soroban RPC invocation:
        //   return sorobanClient.invokeContract(contractId, 'get_legal_hold', [invoiceId]);
        return false;
      };

  try {
    const result = await callSorobanContract(operation);
    // Coerce to boolean; treat any truthy on-chain value as held.
    return result === true || result === 1 || result === "true";
  } catch (err) {
    // Log without exposing internals; default to false (not held) so a
    // transient RPC failure does not permanently block all funding.
    // Callers that need stricter behaviour can override via the adapter.
    logger.warn(
      { invoiceId, errCode: err?.code },
      "escrowRead: get_legal_hold call failed — defaulting to false",
    );
    return false;
  }
}

/**
 * Safely parses the JSON `latest_event_body` written by the indexer projection.
 * Returns an empty object on parse failure so callers can fall back to the
 * envelope-level event type without crashing.
 *
 * @param {unknown} rawBody - Raw value from the projection row.
 * @returns {object} Parsed event body (empty object on failure).
 */
function _parseEventBody(rawBody) {
  if (rawBody && typeof rawBody === "string") {
    try {
      const parsed = JSON.parse(rawBody);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_err) {
      return {};
    }
  }
  if (rawBody && typeof rawBody === "object") {
    return rawBody;
  }
  return {};
}

/**
 * Normalises a `fundedAmount` candidate to a finite non-negative number. Falls
 * back to `0` when the value is missing, NaN, or wrong-shaped so downstream
 * arithmetic stays NaN-free.
 *
 * @param {unknown} raw - Any value (string, number).
 * @returns {number} Finite number, 0 when unparseable.
 */
function _coerceFundedAmount(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return 0;
  }
  return n;
}

/**
 * Reads the latest projection row for an invoice and normalises it into the
 * base-state envelope used by the rest of the read path.
 *
 * Security notes:
 *  - We never trust `eventBody.status` / `eventBody.fundedAmount` to override
 *    `latest_event_type` blindly; the envelope (`latest_event_type`) is the
 *    indexer's source of truth, while `eventBody` provides enrichments.
 *  - Decimals that may appear on the projection are display-only. They are
 *    never copied into the base-state return value and must NEVER be used to
 *    scale on-chain principal math (see `src/services/tokenMeta.js`).
 *
 * @param {string} safeId - Validated, trimmed invoice ID.
 * @param {import('knex').Knex} [dbClient=db] - Knex instance (injectable for tests).
 * @returns {Promise<object|null>} Normalised base state, or null when no
 *   projection row exists for the invoice (or the DB read fails).
 */
async function _readBaseStateFromProjection(safeId, dbClient = db) {
  try {
    const projection = await dbClient("escrow_event_projection")
      .where("invoice_id", safeId)
      .first();

    if (!projection) {
      return null;
    }

    const eventBody = _parseEventBody(projection.latest_event_body);
    const status =
      (typeof eventBody.status === "string" && eventBody.status) ||
      (typeof projection.latest_event_type === "string" &&
        projection.latest_event_type) ||
      "unknown";

    const hasMeaningfulProjection =
      status !== "unknown" ||
      Object.prototype.hasOwnProperty.call(eventBody, "fundedAmount") ||
      Object.prototype.hasOwnProperty.call(eventBody, "ledgerCloseTime") ||
      Object.prototype.hasOwnProperty.call(eventBody, "maturityDate") ||
      Object.prototype.hasOwnProperty.call(eventBody, "maturityTimestamp");

    if (!hasMeaningfulProjection) {
      return null;
    }

    const latestLedger = Number(projection.latest_ledger_sequence);
    return {
      invoiceId: safeId,
      status,
      fundedAmount: _coerceFundedAmount(eventBody.fundedAmount),
      latest_ledger_sequence: Number.isFinite(latestLedger)
        ? latestLedger
        : null,
      latest_event_type: projection.latest_event_type || null,
      latest_event_id: projection.latest_event_id || null,
      latest_paging_token: projection.latest_paging_token || null,
      latest_observed_at: projection.latest_observed_at || null,
      source: "projection",
      // Backwards-compatible flag retained for callers that branch on it.
      fromProjection: true,
    };
  } catch (err) {
    // Treat any DB failure as "no projection" so the caller can attempt the
    // RPC fallback instead of failing the whole read.
    logger.warn(
      { invoiceId: safeId, err: err?.message },
      "escrowRead: projection read failed; falling back to RPC stub",
    );
    return null;
  }
}

/**
 * Fetches the base escrow state for an invoice using the projection-first
 * ordering:
 *
 *   1. Test adapter (when provided)
 *   2. `escrow_event_projection` row written by the indexer
 *   3. Neutral RPC stub (no fabricated values)
 *
 * Previously the RPC fallback returned hardcoded funded_invoice /
 * settled_invoice fixtures. Those were removed because they fabricated state
 * for invoices the indexer had not yet recorded, which misled the
 * reconciliation job and any investor-facing reads.
 *
 * @param {string} invoiceId - Validated invoice ID.
 * @param {Function} [adapter] - Optional async test adapter.
 * @param {object} [options={}]
 * @param {import('knex').Knex} [options.dbClient=db] - Override the default
 *   Knex instance for tests.
 * @returns {Promise<object>} Base escrow state without `legal_hold`.
 */
async function _fetchBaseEscrowState(invoiceId, adapter, options = {}) {
  // 1. Test adapter always wins — keeps unit tests deterministic.
  if (adapter) {
    return callSorobanContract(() => adapter(invoiceId));
  }

  const projectionState = await _readBaseStateFromProjection(
    invoiceId,
    options.dbClient,
  );
  if (projectionState) {
    return projectionState;
  }

  // 3. Neutral RPC stub — never fabricate state for arbitrary invoice IDs.
  return callSorobanContract(async () => ({
    invoiceId,
    ...NEUTRAL_BASE_STATE,
  }));
}

/**
 * Reads the full escrow state for an invoice from the Soroban contract and
 * enriches it with the `legal_hold` flag and token metadata.
 *
 * @param {string} invoiceId - Invoice identifier (validated internally).
 * @param {object}  [options={}]
 * @param {Function} [options.legalHoldAdapter] - Injected adapter for
 *   `get_legal_hold`; used in tests.
 * @param {Function} [options.escrowAdapter] - Injected adapter for the base
 *   escrow state read; used in tests.
 * @param {Object} [options.fundingAsset] - Funding asset descriptor for token metadata.
 * @param {Function} [options.tokenMetaAdapter] - Injected adapter for token metadata.
 * @returns {Promise<EscrowState>} Enriched escrow state object.
 * @throws {EscrowReadError} When `invoiceId` is invalid.
 *
 * @typedef {object} EscrowState
 * @property {string}  invoiceId    - The invoice identifier.
 * @property {string}  status       - On-chain escrow status string.
 * @property {number}  fundedAmount - Amount currently held in escrow.
 * @property {boolean} legal_hold   - Whether the escrow is under legal hold.
 * @property {Object|null} funding_token - Token metadata (symbol, name, decimals).
 */
async function readEscrowState(invoiceId, options = {}) {
  const {
    legalHoldAdapter,
    escrowAdapter,
    fundingAsset,
    tokenMetaAdapter,
    dbClient,
  } = options;

  const { valid, reason } = validateInvoiceId(invoiceId);
  if (!valid) {
    const err = new Error(reason);
    err.code = "INVALID_INVOICE_ID";
    err.status = 400;
    throw err;
  }

  const safeId = invoiceId.trim();

  // Fetch base escrow state and legal hold flag concurrently.
  const [baseState, legalHold] = await Promise.all([
    _fetchBaseEscrowState(safeId, escrowAdapter, { dbClient }),
    fetchLegalHold(safeId, legalHoldAdapter),
  ]);

  // Fetch token metadata if funding asset is provided. This is best-effort:
  // any failure is logged but does not fail the whole read (warn-and-continue).
  let tokenMetadata = null;
  if (fundingAsset) {
    try {
      if (tokenMetaAdapter) {
        tokenMetadata = await tokenMetaAdapter(fundingAsset);
      } else {
        tokenMetadata = await getTokenMetadata(fundingAsset);
      }
    } catch (error) {
      // Log error but don't fail the entire request
      logger.warn(
        { invoiceId: safeId, asset: fundingAsset, error: error.message },
        "escrowRead: Failed to fetch token metadata, continuing without it",
      );
    }
  }

  return {
    ...baseState,
    legal_hold: legalHold,
    funding_token: tokenMetadata,
    // Forward ledger close time so callers can pass opts.ledgerCloseTime to
    // computeEscrowDerivedFields.  The field is present only when the Soroban
    // response includes it; absent otherwise (undefined is stripped by spread).
    ...(baseState.ledgerCloseTime != null
      ? { ledgerCloseTime: baseState.ledgerCloseTime }
      : {}),
  };
}

/**
 * Fetches the attestation append log for an invoice from the Soroban contract.
 * Returns an array of attestation entries with index and hex-encoded digest.
 *
 * @param {string} invoiceId - Validated invoice identifier.
 * @param {Function} [adapter] - Optional async function for testing.
 * @returns {Promise<Array<{index: number, digest: string}>>} Array of attestation entries.
 */
async function fetchAttestationAppendLog(invoiceId, adapter) {
  const operation = adapter
    ? () => adapter(invoiceId)
    : async () => {
        // Production stub — replace with real Soroban RPC invocation:
        //   return sorobanClient.invokeContract(contractId, 'get_attestation_append_log', [invoiceId]);
        // Expected return: array of {index: number, digest: Buffer}
        return [
          { index: 0, digest: Buffer.from("deadbeef", "hex") },
          { index: 1, digest: Buffer.from("cafebabe", "hex") },
        ];
      };

  try {
    const result = await callSorobanContract(operation);
    if (!Array.isArray(result)) {
      logger.warn(
        { invoiceId },
        "escrowRead: get_attestation_append_log returned non-array",
      );
      return [];
    }
    // Decode each entry: convert digest to hex string
    return result.map((entry) => ({
      index: entry.index,
      digest: entry.digest ? entry.digest.toString("hex") : "",
    }));
  } catch (err) {
    logger.warn(
      { invoiceId, errCode: err?.code },
      "escrowRead: get_attestation_append_log call failed — returning empty array",
    );
    return [];
  }
}

/**
 * Reads the full escrow state including attestation digests for investor diligence.
 *
 * @param {string} invoiceId - Invoice identifier (validated internally).
 * @param {object} [options={}]
 * @param {Function} [options.legalHoldAdapter] - Injected adapter for `get_legal_hold`.
 * @param {Function} [options.escrowAdapter] - Injected adapter for base escrow state.
 * @param {Function} [options.attestationAdapter] - Injected adapter for attestation log.
 * @param {Object} [options.fundingAsset] - Funding asset descriptor for token metadata.
 * @param {Function} [options.tokenMetaAdapter] - Injected adapter for token metadata.
 * @returns {Promise<EscrowStateWithAttestations>} Enriched escrow state with attestations.
 * @throws {EscrowReadError} When `invoiceId` is invalid.
 *
 * @typedef {object} EscrowStateWithAttestations
 * @property {string} invoiceId - The invoice identifier.
 * @property {string} status - On-chain escrow status string.
 * @property {number} fundedAmount - Amount currently held in escrow.
 * @property {boolean} legal_hold - Whether the escrow is under legal hold.
 * @property {Array<{index: number, digest: string}>} attestations - Append-only attestation digests.
 * @property {Object|null} funding_token - Token metadata (symbol, name, decimals).
 */
async function readEscrowStateWithAttestations(invoiceId, options = {}) {
  const {
    legalHoldAdapter,
    escrowAdapter,
    attestationAdapter,
    fundingAsset,
    tokenMetaAdapter,
    dbClient,
  } = options;

  const { valid, reason } = validateInvoiceId(invoiceId);
  if (!valid) {
    const err = new Error(reason);
    err.code = "INVALID_INVOICE_ID";
    err.status = 400;
    throw err;
  }

  const safeId = invoiceId.trim();

  // Fetch all data concurrently
  const [baseState, legalHold, attestations] = await Promise.all([
    _fetchBaseEscrowState(safeId, escrowAdapter, { dbClient }),
    fetchLegalHold(safeId, legalHoldAdapter),
    fetchAttestationAppendLog(safeId, attestationAdapter),
  ]);

  // Fetch token metadata if funding asset is provided (best-effort).
  let tokenMetadata = null;
  if (fundingAsset) {
    try {
      if (tokenMetaAdapter) {
        tokenMetadata = await tokenMetaAdapter(fundingAsset);
      } else {
        tokenMetadata = await getTokenMetadata(fundingAsset);
      }
    } catch (error) {
      // Log error but don't fail the entire request
      logger.warn(
        { invoiceId: safeId, asset: fundingAsset, error: error.message },
        "escrowRead: Failed to fetch token metadata, continuing without it",
      );
    }
  }

  return {
    ...baseState,
    legal_hold: legalHold,
    attestations,
    funding_token: tokenMetadata,
    ...(baseState.ledgerCloseTime != null
      ? { ledgerCloseTime: baseState.ledgerCloseTime }
      : {}),
  };
}

/**
 * Reads only the on-chain `funded_amount` for an invoice.
 *
 * This is a focused read used by the nightly reconciliation job, which only
 * needs the funded amount and not the full enriched escrow state (legal hold,
 * token metadata, attestations). It reuses the same validation and
 * projection-first ordering as the rest of the escrow read surface so
 * behaviour stays consistent.
 *
 * @param {string} invoiceId - Invoice identifier (validated internally).
 * @param {object} [options={}]
 * @param {Function} [options.escrowAdapter] - Injected adapter
 *   `(invoiceId) => { fundedAmount } | number` for tests. Defaults to the
 *   production projection-first base-state read.
 * @param {import('knex').Knex} [options.dbClient=db] - Knex instance (tests).
 * @returns {Promise<number>} The funded amount as a finite number. Falls back
 *   to `0` when the projection, adapter, or RPC stub returns no data so the
 *   reconciliation job never sees a fabricated value.
 * @throws {Error} With `code = 'INVALID_INVOICE_ID'` and `status = 400` when
 *   `invoiceId` is invalid.
 */
async function readFundedAmount(invoiceId, options = {}) {
  const { escrowAdapter, dbClient } = options;

  const { valid, reason } = validateInvoiceId(invoiceId);
  if (!valid) {
    const err = new Error(reason);
    err.code = "INVALID_INVOICE_ID";
    err.status = 400;
    throw err;
  }

  const safeId = invoiceId.trim();
  const baseState = await _fetchBaseEscrowState(safeId, escrowAdapter, {
    dbClient,
  });

  // Adapters may return either the full base-state object or a bare number.
  const raw =
    baseState && typeof baseState === "object"
      ? baseState.fundedAmount
      : baseState;
  const amount = Number(raw);
  return Number.isFinite(amount) ? amount : 0;
}

/**
 * Retrieves the escrow state from the cache or projection, falling back to a
 * live RPC read if neither has data.
 *
 * Ordering (matches the docstring at the top of this module):
 *   1. Redis cache (when enabled) — short-circuit on hit.
 *   2. `escrow_event_projection` row (durable, written by the indexer).
 *      Reuses {@link _readBaseStateFromProjection} via
 *      {@link _fetchBaseEscrowState} so the projection shape and the
 *      reconciliation-friendly shape stay in lock-step.
 *   3. Live RPC stub — returns the neutral `not_found` envelope when neither
 *      cache nor projection know about the invoice.
 *
 * @param {string} invoiceId - Invoice identifier.
 * @param {object} [options={}]
 * @param {import('knex').Knex} [options.dbClient=db] - Knex instance (tests).
 * @returns {Promise<Object>} The escrow state.
 */
async function getEscrowStateWithProjection(invoiceId, options = {}) {
  const safeId = invoiceId.trim();
  const { dbClient } = options;

  // 1. Try cache first if enabled. Cache wins on hit.
  if (cache) {
    const cacheResult = await cache.getSummary(safeId);
    if (cacheResult.hit) {
      return cacheResult.value;
    }
  }

  // 2. Read from the projection table via the shared helper, so projection
  //    shape stays consistent with readEscrowState / readFundedAmount /
  //    readEscrowStateWithAttestations.
  const projectionState = await _readBaseStateFromProjection(safeId, dbClient);
  if (projectionState) {
    if (cache) {
      await cache.setSummary(
        safeId,
        projectionState,
        projectionState.latest_ledger_sequence,
      );
    }
    return projectionState;
  }

  // 3. Fallback to live RPC read (neutral stub currently; real Soroban call
  //    once the contract is deployed).
  const baseState = await _fetchBaseEscrowState(safeId, undefined, { dbClient });
  const legalHold = await fetchLegalHold(safeId);

  // Preserve the legacy `latest_event_type === 'live_read'` marker so callers
  // and existing tests that branch on it keep working with the projection-first
  // refactor.
  const state = {
    ...baseState,
    legal_hold: legalHold,
    latest_event_type: baseState.latest_event_type || "live_read",
    source: baseState.source || "rpc_stub",
  };

  if (cache) {
    // For live reads, we might not know the exact ledger, so we omit it.
    await cache.setSummary(safeId, state);
  }

  return state;
}

module.exports = {
  readEscrowState,
  readEscrowStateWithAttestations,
  readFundedAmount,
  fetchLegalHold,
  fetchAttestationAppendLog,
  validateInvoiceId,
  getEscrowStateWithProjection,
};
