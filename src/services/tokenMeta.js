/**
 * @fileoverview Token metadata service for Stellar SEP-41 tokens.
 *
 * Fetches and caches token details (symbol, decimals, name) from Stellar
 * Horizon or Soroban RPC. Implements TTL-based caching with invalidation
 * strategy to balance freshness with performance.
 *
 * IMPORTANT: Cached decimals MUST NOT be used for on-chain principal
 * computations. Always fetch fresh decimals from the chain for financial
 * calculations. Cached metadata is for display/UI purposes only.
 *
 * @module services/tokenMeta
 */

'use strict';

const { createCacheStore } = require('./cacheStore');
const { callSorobanContract } = require('./soroban');
const logger = require('../logger');

/**
 * Default TTL for token metadata cache in milliseconds (30 minutes).
 *
 * @constant {number} DEFAULT_CACHE_TTL_MS
 */
const DEFAULT_CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * Maximum cache size to prevent memory exhaustion.
 *
 * @constant {number} MAX_CACHE_SIZE
 */
const MAX_CACHE_SIZE = 10000;

/**
 * Cache store instance for token metadata.
 *
 * @type {MemoryCacheStore}
 */
const tokenCache = createCacheStore();

/**
 * In-flight promise tracker for single-flight deduplication.
 *
 * @type {Map<string, Promise<Object>>}
 */
const inFlightRequests = new Map();

/**
 * Asset code pattern validation (1-12 alphanumeric characters).
 *
 * @constant {RegExp}
 */
const ASSET_CODE_PATTERN = /^[A-Z0-9]{1,12}$/;

/**
 * Stellar public key pattern (G...).
 *
 * @constant {RegExp}
 */
const STELLAR_PUBLIC_KEY_PATTERN = /^G[A-Z2-7]{55}$/;

/**
 * Soroban contract ID pattern (C...).
 *
 * @constant {RegExp}
 */
const SOROBAN_CONTRACT_ID_PATTERN = /^C[A-Z2-7]{55}$/;

/**
 * Generates a cache key for a token asset.
 *
 * For native XLM: "native"
 * For issued assets: "code:issuer"
 * For Soroban tokens: "contract:contractId"
 *
 * @param {Object} asset - Asset descriptor.
 * @param {string} asset.code - Asset code (or 'native' for XLM).
 * @param {string|null} asset.issuer - Asset issuer (null for native/Soroban).
 * @param {string} [asset.contractId] - Soroban contract ID (for SEP-41 tokens).
 * @returns {string} Cache key.
 */
function generateCacheKey(asset) {
  if (asset.code === 'native' || asset.code === 'XLM') {
    return 'native';
  }
  
  if (asset.contractId) {
    return `contract:${asset.contractId}`;
  }
  
  if (asset.issuer) {
    return `${asset.code}:${asset.issuer}`;
  }
  
  return `code:${asset.code}`;
}

/**
 * Validates an asset descriptor.
 *
 * @param {Object} asset - Asset descriptor to validate.
 * @returns {{valid: boolean, reason?: string}} Validation result.
 */
function validateAsset(asset) {
  if (!asset || typeof asset !== 'object') {
    return { valid: false, reason: 'Asset must be an object' };
  }

  const { code, issuer, contractId } = asset;

  // Handle native XLM
  if (code === 'native' || code === 'XLM') {
    if (issuer !== null && issuer !== undefined) {
      return { valid: false, reason: 'Native XLM must not have an issuer' };
    }
    return { valid: true };
  }

  // Validate asset code
  if (!code || typeof code !== 'string') {
    return { valid: false, reason: 'Asset code is required' };
  }
  if (!ASSET_CODE_PATTERN.test(code)) {
    return { valid: false, reason: 'Asset code must be 1-12 alphanumeric characters' };
  }

  // Validate Soroban contract ID (SEP-41 token)
  if (contractId) {
    if (typeof contractId !== 'string') {
      return { valid: false, reason: 'Contract ID must be a string' };
    }
    if (!SOROBAN_CONTRACT_ID_PATTERN.test(contractId)) {
      return { valid: false, reason: 'Invalid Soroban contract ID format' };
    }
    if (issuer !== null && issuer !== undefined) {
      return { valid: false, reason: 'Soroban tokens must not have an issuer' };
    }
    return { valid: true };
  }

  // Validate issuer for traditional issued assets
  if (issuer) {
    if (typeof issuer !== 'string') {
      return { valid: false, reason: 'Issuer must be a string' };
    }
    if (!STELLAR_PUBLIC_KEY_PATTERN.test(issuer)) {
      return { valid: false, reason: 'Invalid Stellar public key format for issuer' };
    }
  } else {
    return { valid: false, reason: 'Issuer is required for non-native assets' };
  }

  return { valid: true };
}

/**
 * Fetches token metadata from Stellar Horizon for traditional assets.
 *
 * @param {string} code - Asset code.
 * @param {string} _issuer - Asset issuer public key.
 * @returns {Promise<Object>} Token metadata.
 */
async function fetchFromHorizon(code, _issuer) {
  // TODO: Replace with actual Horizon API call
  // const response = await fetch(`${HORIZON_URL}/assets?asset_code=${code}&asset_issuer=${issuer}`);
  // const data = await response.json();
  // if (data._embedded && data._embedded.records && data._embedded.records.length > 0) {
  //   const record = data._embedded.records[0];
  //   return {
  //     symbol: record.asset_code,
  //     name: record.name || record.asset_code,
  //     decimals: parseInt(record.decimals, 10),
  //     source: 'horizon',
  //   };
  // }
  
  // Mock implementation for now
  return {
    symbol: code,
    name: `${code} Token`,
    decimals: 7,
    source: 'horizon',
  };
}

/**
 * Fetches token metadata from Soroban RPC for SEP-41 tokens.
 *
 * @param {string} contractId - Soroban contract ID.
 * @returns {Promise<Object>} Token metadata.
 */
async function fetchFromSoroban(contractId) {
  const operation = async () => {
    // TODO: Replace with actual Soroban SDK call
    // return sorobanClient.invokeContract(contractId, 'decimal', 'name', 'symbol');
    
    // Mock implementation for now
    return {
      symbol: 'TOKEN',
      name: 'Mock Token',
      decimals: 18,
      source: 'soroban',
    };
  };

  try {
    return await callSorobanContract(operation);
  } catch (error) {
    logger.warn(
      { contractId, error: error.message },
      'tokenMeta: Failed to fetch from Soroban RPC, using fallback',
    );
    // Return minimal metadata on RPC failure
    return {
      symbol: contractId.substring(0, 4),
      name: 'Soroban Token',
      decimals: 18,
      source: 'soroban_fallback',
    };
  }
}

/**
 * Fetches native XLM metadata.
 *
 * @returns {Promise<Object>} XLM metadata.
 */
async function fetchNativeMetadata() {
  return {
    symbol: 'XLM',
    name: 'Lumen',
    decimals: 7,
    source: 'native',
  };
}

/**
 * Fetches token metadata with caching.
 *
 * This function implements a cache-aside pattern:
 * 1. Check cache for existing metadata
 * 2. If cache miss, fetch from appropriate source (Horizon/Soroban)
 * 3. Store in cache with TTL
 * 4. Return metadata
 *
 * @param {Object} asset - Asset descriptor.
 * @param {string} asset.code - Asset code (or 'native' for XLM).
 * @param {string|null} asset.issuer - Asset issuer (null for native/Soroban).
 * @param {string} [asset.contractId] - Soroban contract ID (for SEP-41 tokens).
 * @param {Object} [options] - Optional configuration.
 * @param {number} [options.ttlMs] - Cache TTL in milliseconds (default: 30min).
 * @param {boolean} [options.skipCache] - Skip cache and force fresh fetch.
 * @returns {Promise<Object>} Token metadata.
 *
 * @typedef {Object} TokenMetadata
 * @property {string} symbol - Token symbol (e.g., 'USDC', 'XLM').
 * @property {string} name - Token name (e.g., 'USD Coin', 'Lumen').
 * @property {number} decimals - Number of decimal places (for display only).
 * @property {string} source - Source of metadata ('native', 'horizon', 'soroban').
 * @property {number} cachedAt - Timestamp when metadata was cached.
 */
async function getTokenMetadata(asset, options = {}) {
  const { ttlMs = DEFAULT_CACHE_TTL_MS, skipCache = false } = options;
  
  const validation = validateAsset(asset);
  if (!validation.valid) {
    const error = new Error(validation.reason);
    error.code = 'INVALID_ASSET';
    error.status = 400;
    throw error;
  }

  const cacheKey = generateCacheKey(asset);

  // Check cache first (unless skipCache is true)
  if (!skipCache) {
    const cached = tokenCache.get(cacheKey);
    if (cached) {
      logger.debug({ cacheKey, asset }, 'tokenMeta: Cache hit');
      return cached;
    }
  }

  // Check in-flight requests for single-flight deduplication
  const inFlight = inFlightRequests.get(cacheKey);
  if (inFlight) {
    logger.debug({ cacheKey, asset }, 'tokenMeta: Joined in-flight request');
    return inFlight;
  }

  const fetchPromise = (async () => {
    let metadata;
    try {
      // Fetch from appropriate source
      if (asset.code === 'native' || asset.code === 'XLM') {
        metadata = await fetchNativeMetadata();
      } else if (asset.contractId) {
        metadata = await fetchFromSoroban(asset.contractId);
      } else {
        metadata = await fetchFromHorizon(asset.code, asset.issuer);
      }

      // Add cache timestamp
      metadata.cachedAt = Date.now();

      // Store in cache
      try {
        tokenCache.set(cacheKey, metadata, ttlMs);
        logger.debug({ cacheKey, asset, ttlMs }, 'tokenMeta: Cached metadata');
      } catch (error) {
        logger.warn(
          { cacheKey, error: error.message },
          'tokenMeta: Failed to cache metadata (cache may be full)',
        );
      }

      return metadata;
    } finally {
      // Always remove from in-flight tracker when done
      inFlightRequests.delete(cacheKey);
    }
  })();

  inFlightRequests.set(cacheKey, fetchPromise);
  return fetchPromise;
}

/**
 * Invalidates cached metadata for a specific asset.
 *
 * Use this when you know token metadata has changed (e.g., admin update).
 *
 * @param {Object} asset - Asset descriptor.
 * @returns {boolean} True if entry was invalidated, false if not found.
 */
function invalidateTokenMetadata(asset) {
  const validation = validateAsset(asset);
  if (!validation.valid) {
    return false;
  }

  const cacheKey = generateCacheKey(asset);
  const existed = tokenCache.get(cacheKey) !== undefined;
  
  tokenCache.del(cacheKey);
  
  if (existed) {
    logger.info({ cacheKey, asset }, 'tokenMeta: Invalidated cache entry');
  }
  
  return existed;
}

/**
 * Clears all token metadata from cache.
 *
 * Use with caution - this will force all subsequent requests to fetch
 * fresh metadata from RPC/Horizon.
 *
 * @returns {void}
 */
function clearTokenCache() {
  tokenCache.clear();
  logger.info('tokenMeta: Cleared all token metadata cache');
}

/**
 * Gets cache statistics for monitoring.
 *
 * @returns {Object} Cache statistics.
 */
function getCacheStats() {
  return {
    size: tokenCache._cache.size,
    maxSize: MAX_CACHE_SIZE,
    defaultTtlMs: DEFAULT_CACHE_TTL_MS,
  };
}

/**
 * Fetches fresh token metadata bypassing cache.
 *
 * Use this when you need the absolute latest metadata (e.g., after a known
 * contract upgrade or metadata change). This updates the cache with the
 * fresh data.
 *
 * @param {Object} asset - Asset descriptor.
 * @returns {Promise<Object>} Fresh token metadata.
 */
async function getFreshTokenMetadata(asset) {
  return getTokenMetadata(asset, { skipCache: true });
}

/**
 * Batch fetches token metadata for multiple assets.
 *
 * Fetches metadata concurrently for better performance. Uses cache where
 * available.
 *
 * @param {Array<Object>} assets - Array of asset descriptors.
 * @param {Object} [options] - Optional configuration.
 * @param {number} [options.ttlMs] - Cache TTL in milliseconds.
 * @returns {Promise<Array<Object>>} Array of token metadata in same order as input.
 */
async function batchGetTokenMetadata(assets, options = {}) {
  const promises = assets.map(asset => getTokenMetadata(asset, options));
  return Promise.all(promises);
}

/**
 * Resolves token metadata for an array of assets with deduplication and bounded RPC concurrency.
 *
 * Implements:
 * - Input deduplication (duplicate assets share the same lookup).
 * - Cache-first access (cache hits are returned immediately without consuming concurrency slots).
 * - Bounded concurrency (RPC fan-out for cache misses is capped to prevent stampedes).
 * - Single-flight caching (concurrent misses for the same token share one RPC call).
 *
 * IMPORTANT: Cached decimals MUST NOT be used for on-chain principal computations.
 *
 * @param {Array<Object>} assets - Array of asset descriptors to resolve.
 * @param {Object} [options={}] - Batch options.
 * @param {number} [options.concurrency=5] - Maximum concurrent RPC calls.
 * @param {number} [options.ttlMs] - Custom cache TTL.
 * @returns {Promise<Array<Object|null>>} Array of metadata matching the input order.
 */
async function resolveMany(assets, options = {}) {
  const { concurrency = 5, ttlMs = DEFAULT_CACHE_TTL_MS } = options;
  if (!assets || !Array.isArray(assets) || assets.length === 0) {
    return [];
  }

  const uniqueKeys = new Set();
  const missingAssets = [];
  const resultsByKey = new Map();

  // Phase 1: Deduplicate and check cache/in-flight synchronously
  for (const asset of assets) {
    const validation = validateAsset(asset);
    if (!validation.valid) {
      continue;
    }

    const key = generateCacheKey(asset);
    if (!uniqueKeys.has(key)) {
      uniqueKeys.add(key);

      const cached = tokenCache.get(key);
      if (cached) {
        resultsByKey.set(key, cached);
      } else {
        missingAssets.push({ asset, key });
      }
    }
  }

  // Phase 2: Resolve missing assets with bounded concurrency
  const remaining = [...missingAssets];
  
  /**
   * Worker function to process missing assets concurrently.
   *
   * @returns {Promise<void>}
   */
  async function worker() {
    while (remaining.length > 0) {
      const { asset, key } = remaining.shift();
      try {
        const metadata = await getTokenMetadata(asset, { ttlMs, skipCache: false });
        resultsByKey.set(key, metadata);
      } catch (err) {
        logger.error({ err: err.message, key }, 'Failed to resolve token metadata in batch');
        resultsByKey.set(key, null);
      }
    }
  }

  const workers = [];
  const workerCount = Math.min(concurrency, missingAssets.length);
  for (let i = 0; i < workerCount; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);

  // Phase 3: Map results back to original array order
  return assets.map(asset => {
    const validation = validateAsset(asset);
    if (!validation.valid) {
      return null;
    }
    return resultsByKey.get(generateCacheKey(asset)) || null;
  });
}

module.exports = {
  getTokenMetadata,
  getFreshTokenMetadata,
  batchGetTokenMetadata,
  resolveMany,
  invalidateTokenMetadata,
  clearTokenCache,
  getCacheStats,
  validateAsset,
  generateCacheKey,
  DEFAULT_CACHE_TTL_MS,
  MAX_CACHE_SIZE,
};
