'use strict';

/**
 * @fileoverview Rate-limiting middleware with optional Redis-backed store.
 *
 * Issue #429 — multi-instance deployments must share a counter store or the
 * effective rate limit is silently multiplied by the instance count. With
 * the default in-memory store, every replica maintains its own counters,
 * so the effective limit is `configured_limit × instance_count`.
 *
 * This module wires:
 *   1. A Redis-backed store when an explicit client is provided OR when
 *      `src/cache/redis.js#getRedisClient()` reports the linked client is
 *      available. Falls back to in-memory (`MemoryStore` from
 *      `express-rate-limit`) when no client is reachable.
 *   2. One `logger.warn(...)` line per limiter scope when the in-memory
 *      store is used in a clustered deployment (`WEB_CONCURRENCY > 1` or
 *      `CLUSTER_WORKERS > 1`). The warning tells the operator exactly
 *      which scope is in-memory and provides a remediation pointer.
 *   3. Spoofing-safe key generation. The key reads the direct TCP socket
 *      peer (`req.socket.remoteAddress`) and never the request IP stack;
 *      `validate.xForwardedForHeader: false` is set on every limiter so
 *      a future `app.set('trust proxy', ...)` cannot silently turn the
 *      limiter into a per-attacker-keyed no-op via `X-Forwarded-For`.
 *
 * Public API (preserved for backward compatibility):
 *   - `createRateLimiter(scope, windowMs, max, opts)` — factory.
 *   - `globalLimiter`, `sensitiveLimiter`, `apiKeyLimiter` — middleware.
 *   - `parseRateLimitEnv`, `keyGenerator`, `apiKeyKeyGenerator`,
 *     `getApiKey` — pure helpers preserved for tests and external callers.
 *   - `CLUSTER_SIGNAL`, `detectClusteredDeployment`,
 *     `loadRedisStoreCtor`, `buildRedisStore`, `socketPeerAddress`,
 *     `isMemoryInClusterWarning`, `resolveRedisClient` — inspection + new
 *     factory helpers for issue #429.
 *
 * Environment variables consumed:
 *   - `RATE_LIMIT_WINDOW_MS`         — global limiter window  (default 15m)
 *   - `RATE_LIMIT_MAX_REQUESTS`      — global limiter limit  (default 100)
 *   - `RATE_LIMIT_SENSITIVE_WINDOW_MS` — sensitive window     (default 1h)
 *   - `RATE_LIMIT_SENSITIVE_MAX`     — sensitive limit       (default 40)
 *   - `RATE_LIMIT_API_KEY_WINDOW_MS` — api-key window        (default 15m)
 *   - `RATE_LIMIT_API_KEY_MAX`       — api-key limit         (default 1000)
 *   - `WEB_CONCURRENCY`              — multi-instance signal (Heroku conv.)
 *   - `CLUSTER_WORKERS`              — multi-instance signal (PM2 / k8s alt)
 *
 * @module middleware/rateLimit
 */

const expressRateLimit = require('express-rate-limit');
const logger = require('../logger');

/**
 * @typedef {object} RateLimitScopeOptions
 * @property {object|null} [redisClient] - Optional Redis client. Must
 *   expose `sendCommand` (compatible with `node-redis` v4+) or `.call`
 *   (compatible with `ioredis`).
 */

// ============================================================================
// Test-only state and helpers (issue #429)
//
// The functions and `let`s below are referenced by the test suite. They are
// declared at module scope (not as methods) so the production call sites
// remain readable. Production callers should NOT depend on any identifier
// prefixed with `_`.
// ============================================================================

let _redisStoreCtor = null;
let _allowClusterWarnInTests = false;
let _sharedMemoryWarningEmitted = false;

/**
 * Test-only: enable or disable the cluster-warning emitter while NODE_ENV=test.
 * @param {boolean} value
 * @returns {void}
 */
function _setClusterWarningsAllowedInTestsForTests(value) {
  _allowClusterWarnInTests = !!value;
}

/**
 * Test-only: returns the singleton logger so spies can attach to its methods.
 * @returns {object}
 */
function _loggerForTests() {
  return logger;
}

/**
 * Test-only: resets the "summary warning already emitted" latch.
 * @returns {void}
 */
function _resetMemoryWarningLatchForTests() {
  _sharedMemoryWarningEmitted = false;
}

/**
 * Test-only: clears the cached Redis-store constructor.
 * @returns {void}
 */
function _resetRedisStoreCtorCacheForTests() {
  _redisStoreCtor = null;
}

// ============================================================================
// Helpers (hoisted function declarations)
// ============================================================================

/**
 * Reads the direct TCP socket peer address. The `req.ip` fallback is
 * retained for legacy test-contract compatibility. Under express-rate-limit
 * v7's `validate.xForwardedForHeader:false`, requests bearing an
 * `X-Forwarded-For` header are rejected before keying, so the fallback
 * path cannot spoof a forwarded IP in practice.
 *
 * Spoofing-safety contract: every `createRateLimiter` instance is
 * constructed with `validate.xForwardedForHeader: false`. If you flip
 * that flag to `true`, REMOVE the `req.ip` fallback below too — otherwise
 * an operator that turns on `app.set('trust proxy', 'true')` silently
 * re-introduces XFF spoofing.
 *
 * @param {object|undefined} req - Express request.
 * @returns {string}
 */
function socketPeerAddress(req) {
  const sock = req && req.socket;
  if (sock && typeof sock.remoteAddress === 'string' && sock.remoteAddress.length > 0) {
    return sock.remoteAddress;
  }
  if (req && typeof req.ip === 'string' && req.ip.length > 0) {
    return req.ip;
  }
  return '127.0.0.1';
}

/**
 * Reads `req.headers['x-api-key']` and trims. Returns `undefined` when no
 * string-shaped key is present.
 * @param {object|undefined} req
 * @returns {string|undefined}
 */
function getApiKey(req) {
  const headers = (req && req.headers) || {};
  const apiKey = headers['x-api-key'];
  return typeof apiKey === 'string' ? apiKey.trim() : undefined;
}

/**
 * Legacy keyGenerator. (user id, then API key, then peer address).
 * @param {object} req
 * @returns {string}
 */
function keyGenerator(req) {
  if (req && req.user && req.user.id) {
    return `user_${req.user.id}`;
  }
  const apiKey = getApiKey(req);
  if (apiKey) {
    return `apikey_${apiKey}`;
  }
  return socketPeerAddress(req);
}

/**
 * API-key-only keyGenerator.
 * @param {object} req
 * @returns {string}
 */
function apiKeyKeyGenerator(req) {
  const apiKey = getApiKey(req);
  if (apiKey) {
    return `apikey_${apiKey}`;
  }
  return socketPeerAddress(req);
}

/**
 * Parses a positive-integer env var or returns the default.
 * @param {string} envVar
 * @param {number} defaultValue
 * @returns {number}
 */
function parseRateLimitEnv(envVar, defaultValue) {
  const value = process.env[envVar];
  if (!value) {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
}

/**
 * Pure env-reading multi-instance detector.
 * @returns {{clustered: boolean, signal: string|null, value: number}}
 */
function detectClusteredDeployment() {
  const wc = parseInt(process.env.WEB_CONCURRENCY || '', 10);
  if (Number.isFinite(wc) && wc > 1) {
    return { clustered: true, signal: 'WEB_CONCURRENCY', value: wc };
  }
  const cw = parseInt(process.env.CLUSTER_WORKERS || '', 10);
  if (Number.isFinite(cw) && cw > 1) {
    return { clustered: true, signal: 'CLUSTER_WORKERS', value: cw };
  }
  return { clustered: false, signal: null, value: 0 };
}

/**
 * True iff a memory-in-cluster warning has already been emitted this process.
 * @returns {boolean}
 */
function isMemoryInClusterWarning() {
  return _sharedMemoryWarningEmitted;
}

/**
 * Emit a structured `logger.warn` line when a limiter is constructed with
 * an in-memory store in a clustered deployment.
 * @param {string} scope
 * @param {string} storeType
 * @returns {void}
 */
function maybeWarnMemoryInCluster(scope, storeType) {
  if (storeType !== 'memory') {
    return;
  }
  if (!CLUSTER_SIGNAL.clustered) {
    return;
  }
  if (process.env.NODE_ENV === 'test' && !_allowClusterWarnInTests) {
    return;
  }
  if (!_sharedMemoryWarningEmitted) {
    _sharedMemoryWarningEmitted = true;
    logger.warn(
      {
        component: 'rate-limit',
        event: 'memory_in_cluster',
        scope,
        signal: CLUSTER_SIGNAL.signal,
        webConcurrency: CLUSTER_SIGNAL.value,
        recommendation:
          'Install @express-rate-limit/redis (preferred) or rate-limit-redis and provide a Redis client via createRateLimiter(scope, win, max, { redisClient }) so counters are shared across instances.',
      },
      'rate-limit: in-memory store active in clustered deployment — effective limits are multiplied by instance count',
    );
    return;
  }
  logger.warn(
    {
      component: 'rate-limit',
      event: 'memory_in_cluster_additional_scope',
      scope,
      signal: CLUSTER_SIGNAL.signal,
      webConcurrency: CLUSTER_SIGNAL.value,
    },
    'rate-limit: additional limiter constructed with in-memory store in clustered deployment',
  );
}

/**
 * Lazy-load the Redis-store constructor; tries `@express-rate-limit/redis`
 * first then `rate-limit-redis`. Emits a structured warning when both fail.
 * @returns {Function|null}
 */
function loadRedisStoreCtor() {
  if (_redisStoreCtor !== null) {
    return _redisStoreCtor;
  }
  const candidates = ['@express-rate-limit/redis', 'rate-limit-redis'];
  const failures = [];
  for (const pkg of candidates) {
    try {
      // eslint-disable-next-line security/detect-non-literal-require
      const mod = require(pkg);
      const Ctor = mod && (mod.RedisStore || (mod.default && mod.default.RedisStore));
      if (typeof Ctor === 'function') {
        _redisStoreCtor = Ctor;
        return _redisStoreCtor;
      }
      failures.push(`${pkg}: no RedisStore export`);
    } catch (loadErr) {
      failures.push(`${pkg}: ${loadErr && loadErr.message ? loadErr.message : 'require failed'}`);
    }
  }
  logger.warn(
    {
      component: 'rate-limit',
      event: 'redis_store_unavailable',
      attempts: failures,
      recommendation:
        'npm install @express-rate-limit/redis (preferred) or rate-limit-redis so counters can be shared across instances.',
    },
    'rate-limit: no Redis store package installed — falling back to in-memory counters',
  );
  return null;
}

/**
 * Build an adapter that satisfies express-rate-limit's `sendCommand(...args)`
 * convention from either a `node-redis` client (already speaks that) or an
 * `ioredis` client (which speaks `call(cmd, ...restArgs)`).
 *
 * Express-rate-limit calls `sendCommand(parts)` where `parts` is an array
 * like `['INCR', 'ratelimit:scope:key']`. So `...args` collapses into a
 * single-element array `[['INCR', 'ratelimit:scope:key']]`. `args[0]` is
 * that array.
 *
 * @param {object} client
 * @returns {Function|null}
 */
function adaptClientSendCommand(client) {
  if (!client || typeof client !== 'object') {
    return null;
  }
  if (typeof client.sendCommand === 'function') {
    // node-redis v4+ accepts an array of command parts.
    return (...args) => client.sendCommand(args[0]);
  }
  if (typeof client.call === 'function') {
    // ioredis accepts `(cmd, ...restArgs)`; spread the parts array back out.
    return (...args) => client.call(...args[0]);
  }
  return null;
}

/**
 * Resolve which Redis client to use, given an optional explicit override.
 * Order: (1) explicit if it has `sendCommand` or `call`, (2)
 * `src/cache/redis.js#getRedisClient().client` if non-null, (3) `null`.
 *
 * The cache-module require is deferred to dodge the upstream/main
 * `src/metrics.js` TDZ pre-existing baseline.
 *
 * @param {object|null} explicitClient
 * @returns {object|null}
 */
function resolveRedisClient(explicitClient) {
  if (explicitClient && (typeof explicitClient.sendCommand === 'function' || typeof explicitClient.call === 'function')) {
    return explicitClient;
  }
  try {
    const redisModule = require('../cache/redis');
    const ctx = (redisModule && typeof redisModule.getRedisClient === 'function')
      ? redisModule.getRedisClient()
      : { client: null };
    if (ctx && ctx.client && (typeof ctx.client.sendCommand === 'function' || typeof ctx.client.call === 'function')) {
      return ctx.client;
    }
  } catch (_resolveErr) {
    // Cache module unavailable — treat as "no shared client".
  }
  return null;
}

/**
 * Build a Redis-backed `RateLimitStore` instance for a single scope. Returns
 * `null` when no client is reachable, the Redis-store package is missing,
 * or the constructor throws.
 *
 * Routes through `module.exports.loadRedisStoreCtor()` so test spies on the
 * export reach this call site.
 *
 * @param {string} scope
 * @param {object|null} redisClient
 * @returns {object|null}
 */
function buildRedisStore(scope, redisClient) {
  if (!redisClient) {
    return null;
  }
  const Ctor = module.exports.loadRedisStoreCtor();
  if (typeof Ctor !== 'function') {
    return null;
  }
  const sendCommand = adaptClientSendCommand(redisClient);
  if (!sendCommand) {
    return null;
  }
  try {
    return new Ctor({
      sendCommand,
      prefix: `rate-limit:${scope}:`,
    });
  } catch (_ctorErr) {
    return null;
  }
}

/**
 * Build an Express middleware that rate-limits requests inside the given
 * scope. Resolution order, anti-spoof guard, and warning path documented
 * at top of file. Routes through `module.exports.resolveRedisClient` and
 * `module.exports.buildRedisStore` so `jest.spyOn(api, ...)` reaches
 * this call site.
 *
 * @param {string} scope
 * @param {number} [windowMs=GLOBAL_WINDOW_MS]
 * @param {number} [max=GLOBAL_MAX_REQUESTS]
 * @param {object} [opts]
 * @returns {Function}
 */
function createRateLimiter(scope, windowMs = GLOBAL_WINDOW_MS, max = GLOBAL_MAX_REQUESTS, opts = {}) {
  const explicit = opts && opts.redisClient ? opts.redisClient : null;
  const redisClient = module.exports.resolveRedisClient(explicit);
  const store = module.exports.buildRedisStore(scope, redisClient);
  const storeType = store ? 'redis' : 'memory';

  maybeWarnMemoryInCluster(scope, storeType);

  const limiter = expressRateLimit({
    windowMs,
    limit: max,
    standardHeaders: true,
    legacyHeaders: true,
    store,
    keyGenerator,
    validate: { xForwardedForHeader: false },
    handler: (req, res, _next, options) => {
      res.status(options.statusCode).json({
        error: 'Too many requests.',
        message: `Rate limit threshold breached for scope: ${scope}. Please try again later.`,
      });
    },
  });

  limiter.__liquifactStoreType = storeType;
  limiter.__liquifactScope = scope;
  return limiter;
}

// ============================================================================
// Configuration constants and module-load cluster signal
// ============================================================================

const DEFAULT_GLOBAL_WINDOW_MS    = 15 * 60 * 1000;
const DEFAULT_GLOBAL_MAX          = 100;
const DEFAULT_SENSITIVE_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_SENSITIVE_MAX       = 40;
const DEFAULT_API_KEY_WINDOW_MS   = 15 * 60 * 1000;
const DEFAULT_API_KEY_MAX         = 1000;

const GLOBAL_WINDOW_MS      = parseRateLimitEnv('RATE_LIMIT_WINDOW_MS',           DEFAULT_GLOBAL_WINDOW_MS);
const GLOBAL_MAX_REQUESTS  = parseRateLimitEnv('RATE_LIMIT_MAX_REQUESTS',        DEFAULT_GLOBAL_MAX);
const SENSITIVE_WINDOW_MS  = parseRateLimitEnv('RATE_LIMIT_SENSITIVE_WINDOW_MS', DEFAULT_SENSITIVE_WINDOW_MS);
const SENSITIVE_MAX        = parseRateLimitEnv('RATE_LIMIT_SENSITIVE_MAX',       DEFAULT_SENSITIVE_MAX);
const API_KEY_WINDOW_MS    = parseRateLimitEnv('RATE_LIMIT_API_KEY_WINDOW_MS',   DEFAULT_API_KEY_WINDOW_MS);
const API_KEY_MAX          = parseRateLimitEnv('RATE_LIMIT_API_KEY_MAX',         DEFAULT_API_KEY_MAX);

const CLUSTER_SIGNAL = detectClusteredDeployment();

// ============================================================================
// module.exports is assigned BEFORE the pre-built limiters are constructed
// so `createRateLimiter()` (which routes through `module.exports.X` to be
// spy-honest in tests) finds the helpers at module-load time.
// ============================================================================

module.exports = {
  // Factory + state inspectors (new in #429)
  createRateLimiter,
  loadRedisStoreCtor,
  buildRedisStore,
  resolveRedisClient,
  detectClusteredDeployment,
  isMemoryInClusterWarning,
  CLUSTER_SIGNAL,
  parseRateLimitEnv,
  socketPeerAddress,
  // Pure-function helpers (preserved for backward compatibility)
  keyGenerator,
  apiKeyKeyGenerator,
  getApiKey,
  // Test-only seams (issue #429)
  _loggerForTests,
  _resetMemoryWarningLatchForTests,
  _detectClusterForTests: _detectClusterForTestsImpl,
  _resetRedisStoreCtorCacheForTests,
  _setClusterWarningsAllowedInTestsForTests,
};

/**
 * Test-only: re-evaluates `detectClusteredDeployment()` and overwrites the
 * captured `CLUSTER_SIGNAL` value.
 * @returns {{clustered: boolean, signal: string|null, value: number}}
 */
function _detectClusterForTestsImpl() {
  const refreshed = detectClusteredDeployment();
  CLUSTER_SIGNAL.clustered = refreshed.clustered;
  CLUSTER_SIGNAL.signal = refreshed.signal;
  CLUSTER_SIGNAL.value = refreshed.value;
  return CLUSTER_SIGNAL;
}

// ============================================================================
// Pre-built limiters (legacy) — preserved for backward compatibility.
// ============================================================================

const globalLimiter   = createRateLimiter('global',    GLOBAL_WINDOW_MS,   GLOBAL_MAX_REQUESTS);
const sensitiveLimiter = createRateLimiter('sensitive', SENSITIVE_WINDOW_MS, SENSITIVE_MAX);
const apiKeyLimiter   = createRateLimiter('api-key',   API_KEY_WINDOW_MS,   API_KEY_MAX);

Object.assign(module.exports, {
  globalLimiter,
  sensitiveLimiter,
  apiKeyLimiter,
});
