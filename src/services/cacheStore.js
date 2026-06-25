/**
 * In-memory cache store backed by a native Map.
 * Each entry is stored with an expiry timestamp for TTL-based eviction.
 *
 * @class
 */
class MemoryCacheStore {
  /**
   * Creates a new MemoryCacheStore instance.
   *
   * @returns {MemoryCacheStore} A new cache store.
   */
  constructor() {
    this._cache = new Map();
  }

  /**
   * Retrieves a cached value by key. Returns undefined if the key is missing
   * or expired. Expired entries are lazily evicted.
   *
   * @param {string} key - The cache key to look up.
   * @returns {*} The cached value, or undefined if missing/expired.
   */
  get(key) {
    const entry = this._cache.get(key);
    if (!entry) {
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      this._cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /**
   * Stores a value in the cache with a TTL in milliseconds.
   *
   * @param {string} key - The cache key.
   * @param {*} value - The value to cache.
   * @param {number} ttlMs - Time-to-live in milliseconds.
   * @returns {void}
   */
  set(key, value, ttlMs) {
    this._cache.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
  }

  /**
   * Removes a specific entry from the cache.
   *
   * @param {string} key - The cache key to remove.
   * @returns {void}
   */
  del(key) {
    this._cache.delete(key);
  }

  /**
   * Returns all currently valid (non-expired) cache keys.
   *
   * Expired entries are lazily evicted during iteration.
   *
   * @returns {string[]} Array of active cache keys.
   */
  keys() {
    const now = Date.now();
    const valid = [];
    for (const [key, entry] of this._cache) {
      if (now <= entry.expiresAt) {
        valid.push(key);
      } else {
        this._cache.delete(key);
      }
    }
    return valid;
  }

  /**
   * Deletes all cache entries whose key starts with the given prefix.
   * Expired entries are also cleaned up during iteration.
   *
   * @param {string} prefix - The key prefix to match.
   * @returns {void}
   */
  delByPrefix(prefix) {
    const now = Date.now();
    for (const [key, entry] of this._cache) {
      if (now > entry.expiresAt) {
        this._cache.delete(key);
      } else if (key.startsWith(prefix)) {
        this._cache.delete(key);
      }
    }
  }

  /**
   * Removes all entries from the cache.
   *
   * @returns {void}
   */
  clear() {
    this._cache.clear();
  }
}

/**
 * Factory function that creates a cache store instance.
 * Currently returns a MemoryCacheStore. Future implementations can check
 * for REDIS_URL and return a Redis-backed store.
 *
 * @returns {MemoryCacheStore} A cache store instance.
 */
function createCacheStore() {
  return new MemoryCacheStore();
}

/**
 * Returns a shared singleton cache store instance.
 *
 * All middleware and services that need to read or invalidate cache entries
 * should use this instance to ensure consistency.
 *
 * @returns {MemoryCacheStore} The shared cache store.
 */
function getSharedStore() {
  if (!_sharedInstance) {
    _sharedInstance = new MemoryCacheStore();
  }
  return _sharedInstance;
}

let _sharedInstance = null;

module.exports = {
  MemoryCacheStore,
  createCacheStore,
  getSharedStore,
};
