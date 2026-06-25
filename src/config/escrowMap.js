/**
 * src/config/escrowMap.js
 *
 * Resolves an invoiceId to its on-chain LiquifactEscrow contract address.
 *
 * Configuration is supplied via the ESCROW_ADDR_BY_INVOICE environment variable
 * (JSON). This avoids storing addresses in source code and allows per-environment
 * rotation without a redeploy.
 *
 * Schema of ESCROW_ADDR_BY_INVOICE (see README for full example):
 * {
 *   "mappings": [
 *     {
 *       "invoiceId": "inv_001",
 *       "escrowAddress": "GABC...123",
 *       "environment": "production",
 *       "isActive": true
 *     }
 *   ],
 *   "defaultEnvironment": "production",
 *   "allowlistEnabled": true,
 *   "cacheEnabled": true,
 *   "cacheTtlSeconds": 300
 * }
 *
 * Throws EscrowNotFoundError when no active mapping exists for the invoice in
 * the current environment. Callers should translate this to a 404 / 422.
 */

'use strict';

const STELLAR_ADDRESS_RE = /^[CG][A-Z2-7]{55}$/;

class EscrowNotFoundError extends Error {
  /**
   * Creates an instance of EscrowNotFoundError.
   * @param {string} invoiceId The ID of the invoice for which no escrow was found.
   */
  constructor(invoiceId) {
    super(`No active escrow contract mapped for invoiceId: ${invoiceId}`);
    this.name = 'EscrowNotFoundError';
    this.invoiceId = invoiceId;
  }
}

class EscrowMapConfigError extends Error {
  /**
   * Creates an instance of EscrowMapConfigError.
   * @param {string} message The error message.
   */
  constructor(message) {
    super(message);
    this.name = 'EscrowMapConfigError';
  }
}

/**
 * Parses and validates the raw escrow map configuration from the environment variable.
 * @returns {{ mappings: Array, defaultEnvironment: string, allowlistEnabled: boolean }} The parsed and validated configuration.
 * @throws {EscrowMapConfigError} If the configuration JSON is malformed or invalid.
 */
function _parseConfig() {
  const raw = process.env.ESCROW_ADDR_BY_INVOICE;
  if (!raw) {
    return { mappings: [], defaultEnvironment: 'development', allowlistEnabled: false };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_error) {
    throw new EscrowMapConfigError(
      'ESCROW_ADDR_BY_INVOICE is not valid JSON. Check your environment configuration.'
    );
  }

  if (!Array.isArray(parsed.mappings)) {
    throw new EscrowMapConfigError('ESCROW_ADDR_BY_INVOICE.mappings must be an array.');
  }

  for (const m of parsed.mappings) {
    if (!m.invoiceId || typeof m.invoiceId !== 'string') {
      throw new EscrowMapConfigError('Each mapping must have a string invoiceId.');
    }
    if (!m.escrowAddress || !STELLAR_ADDRESS_RE.test(m.escrowAddress)) {
      throw new EscrowMapConfigError(
        `Mapping for ${m.invoiceId} has an invalid Stellar escrowAddress.`
      );
    }
  }

  return {
    mappings: parsed.mappings,
    defaultEnvironment: parsed.defaultEnvironment || 'development',
    allowlistEnabled: Boolean(parsed.allowlistEnabled),
  };
}

// Simple module-level in-memory cache
let _cache = null;

/**
 * Retrieves the escrow map configuration, utilizing a memoized cache.
 * @returns {{ mappings: Array, defaultEnvironment: string, allowlistEnabled: boolean }} The escrow map configuration.
 * @throws {EscrowMapConfigError} If the configuration is invalid during parsing.
 */
function _getConfig() {
  if (!_cache) {
    _cache = _parseConfig();
  }
  return _cache;
}

/** Exposed for tests to reset the cache between test cases. */
function _resetCache() {
  _cache = null;
}

/**
 * Resolve the escrow contract address for a given invoiceId.
 *
 * @param {string} invoiceId
 * @returns {string} Stellar contract address (C... or G...)
 * @throws {EscrowNotFoundError} when no active mapping exists
 * @throws {EscrowMapConfigError} when the config JSON is malformed
 */
function resolveEscrowAddress(invoiceId) {
  const { mappings, defaultEnvironment, allowlistEnabled } = _getConfig();
  const env = process.env.NODE_ENV || defaultEnvironment;

  const match = mappings.find(
    (m) => m.invoiceId === invoiceId && m.isActive !== false && m.environment === env
  );

  if (!match) {
    // When allowlist is disabled and no mapping exists, still fail — callers
    // must always have an explicit mapping to prevent accidental fund misrouting.
    throw new EscrowNotFoundError(invoiceId);
  }

  return match.escrowAddress;
}

module.exports = {
  resolveEscrowAddress,
  EscrowNotFoundError,
  EscrowMapConfigError,
  _resetCache, // test-only
};