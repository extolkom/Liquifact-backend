/**
 * Rate Limiting Middleware
 * Protects endpoints from abuse and DoS using IP and token-based limiting.
 * Supports per-IP and per-API key limiting via environment variables.
 *
 * Environment Variables:
 * - RATE_LIMIT_WINDOW_MS: Time window in milliseconds (default: 15 minutes)
 * - RATE_LIMIT_MAX_REQUESTS: Max requests per window for global limiter (default: 100)
 * - RATE_LIMIT_SENSITIVE_WINDOW_MS: Time window for sensitive endpoints (default: 1 hour)
 * - RATE_LIMIT_SENSITIVE_MAX: Max requests per window for sensitive limiter (default: 40)
 * - RATE_LIMIT_API_KEY_WINDOW_MS: Time window for API key limit (default: 15 minutes)
 * - RATE_LIMIT_API_KEY_MAX: Max requests per window per API key (default: 1000)
 */

const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { getRedisClient } = require('../cache/redis');

/**
 * Parse environment variable as positive integer.
 * @param {string} envVar - Environment variable name.
 * @param {number} defaultValue - Default value if parse fails.
 * @returns {number} Parsed integer value.
 */
function parseRateLimitEnv(envVar, defaultValue) {
  const value = process.env[envVar];
  if (!value) { return defaultValue; }
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) || parsed < 0 ? defaultValue : parsed;
}

/**
 * Gets the API key from request headers or returns undefined.
 * @param {import('express').Request} req - Express request object.
 * @returns {string|undefined} The API key if present.
 */
function getApiKey(req) {
  const headers = req.headers || {};
  const apiKey = headers['x-api-key'];
  return typeof apiKey === 'string' ? apiKey.trim() : undefined;
}

/**
 * Generates a rate-limit key using user ID, API key, or IP address.
 * Uses API key when available for more granular limiting.
 *
 * @param {import('express').Request} req - Express request object.
 * @returns {string} The rate-limit key.
 */
function keyGenerator(req) {
  if (req.user && req.user.id) {
    return `user_${req.user.id}`;
  }
  const apiKey = getApiKey(req);
  if (apiKey) {
    return `apikey_${apiKey}`;
  }
  return req.ip || req.socket?.remoteAddress || '127.0.0.1';
}

/**
 * Generates a rate-limit key specifically for API key-based limiting.
 * Falls back to IP when no API key is present.
 *
 * @param {import('express').Request} req - Express request object.
 * @returns {string} The rate-limit key.
 */
function apiKeyKeyGenerator(req) {
  const apiKey = getApiKey(req);
  if (apiKey) {
    return `apikey_${apiKey}`;
  }
  return req.ip || req.socket?.remoteAddress || '127.0.0.1';
}

/**
 * Creates an isolated, context-aware rate limiting middleware block.
 * Uses a Redis backing layer if available, otherwise safely falls back to standard memory tracks.
 *
 * @param {string} scope - The structural namespace isolation marker (e.g., 'global', 'sensitive', 'api-key')
 * @param {number} windowMs - The tracking duration window block in milliseconds
 * @param {number} max - Request limits allowed inside the designated window frame
 * @returns {Function} Express middleware handler
 */
function createRateLimiter(scope, windowMs, max) {
  const { client, isAvailable } = getRedisClient();
  let store;

  if (isAvailable && client) {
    store = new RedisStore({
      sendCommand: (...args) => client.sendCommand(args),
      prefix: `rate-limit:${scope}:`,
    });
  } else {
    console.warn(`[RateLimit] Redis store unavailable for scope [${scope}]. Falling back safely to MemoryStore.`);
  }

  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: true,
    legacyHeaders: false,
    store,
    keyGenerator,
    handler: (req, res, next, options) => {
      res.status(options.statusCode).json({
        error: 'Too many requests.',
        message: `Rate limit threshold breached for scope: ${scope}. Please try again later.`,
      });
    },
    // Fail-open strategy: If Redis times out or fails midway through execution, log warning and let request bypass
    skip: () => {
      if (store && !getRedisClient().isAvailable) {
        console.error(`[RateLimit] Emergency fail-open bypass activated on scope [${scope}] due to live Redis link dropout.`);
        return true;
      }
      return false;
    },
    validate: {
      xForwardedForHeader: false,
    },
  });
}

const GLOBAL_WINDOW_MS = parseRateLimitEnv('RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000);
const GLOBAL_MAX_REQUESTS = parseRateLimitEnv('RATE_LIMIT_MAX_REQUESTS', 100);
const SENSITIVE_WINDOW_MS = parseRateLimitEnv('RATE_LIMIT_SENSITIVE_WINDOW_MS', 60 * 60 * 1000);
const SENSITIVE_MAX = parseRateLimitEnv('RATE_LIMIT_SENSITIVE_MAX', 40);
const API_KEY_WINDOW_MS = parseRateLimitEnv('RATE_LIMIT_API_KEY_WINDOW_MS', 15 * 60 * 1000);
const API_KEY_MAX = parseRateLimitEnv('RATE_LIMIT_API_KEY_MAX', 1000);

/**
 * Standard global rate limiter for all API endpoints.
 * Limits each IP/API key to configured requests per window.
 */
const globalLimiter = createRateLimiter('global', GLOBAL_WINDOW_MS, GLOBAL_MAX_REQUESTS);

/**
 * Stricter limiter for sensitive operations (Invoices, Escrow).
 * Limits each IP/API key to configured requests per hour.
 */
const sensitiveLimiter = createRateLimiter('sensitive', SENSITIVE_WINDOW_MS, SENSITIVE_MAX);

/**
 * API key specific rate limiter.
 * Allows higher limits for authenticated API key clients.
 * Falls back to IP-based limiting when no API key is provided.
 */
const apiKeyLimiter = createRateLimiter('api-key', API_KEY_WINDOW_MS, API_KEY_MAX);

module.exports = {
  createRateLimiter,
  globalLimiter,
  sensitiveLimiter,
  apiKeyLimiter,
  parseRateLimitEnv,
  keyGenerator,
  apiKeyKeyGenerator,
  getApiKey,
};