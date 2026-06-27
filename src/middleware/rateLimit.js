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

const GLOBAL_WINDOW_MS = parseRateLimitEnv('RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000);
const GLOBAL_MAX_REQUESTS = parseRateLimitEnv('RATE_LIMIT_MAX_REQUESTS', 100);
const SENSITIVE_WINDOW_MS = parseRateLimitEnv('RATE_LIMIT_SENSITIVE_WINDOW_MS', 60 * 60 * 1000);
const SENSITIVE_MAX = parseRateLimitEnv('RATE_LIMIT_SENSITIVE_MAX', 40);
const API_KEY_WINDOW_MS = parseRateLimitEnv('RATE_LIMIT_API_KEY_WINDOW_MS', 15 * 60 * 1000);
const API_KEY_MAX = parseRateLimitEnv('RATE_LIMIT_API_KEY_MAX', 1000);

/**
 * Standard global rate limiter for all API endpoints.
 * Limits each IP/API key to configured requests per window.
 *
 * @returns {Function} Express rate limiting middleware.
 */
const globalLimiter = rateLimit({
  windowMs: GLOBAL_WINDOW_MS,
  limit: GLOBAL_MAX_REQUESTS,
  message: {
    error: `Too many requests from this IP/API key, please try again after ${Math.round(GLOBAL_WINDOW_MS / 60000)} minutes`,
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  validate: {
    xForwardedForHeader: false,
  },
});

/**
 * Stricter limiter for sensitive operations (Invoices, Escrow).
 * Limits each IP/API key to configured requests per hour.
 *
 * @returns {Function} Express rate limiting middleware.
 */
const sensitiveLimiter = rateLimit({
  windowMs: SENSITIVE_WINDOW_MS,
  limit: SENSITIVE_MAX,
  message: {
    error: `Strict rate limit exceeded for sensitive operations. Please try again later.`,
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  validate: {
    xForwardedForHeader: false,
  },
});

/**
 * API key specific rate limiter.
 * Allows higher limits for authenticated API key clients.
 * Falls back to IP-based limiting when no API key is provided.
 *
 * @returns {Function} Express rate limiting middleware.
 */
const apiKeyLimiter = rateLimit({
  windowMs: API_KEY_WINDOW_MS,
  limit: API_KEY_MAX,
  message: {
    error: `API key rate limit exceeded. Max ${API_KEY_MAX} requests per ${Math.round(API_KEY_WINDOW_MS / 60000)} minutes.`,
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: apiKeyKeyGenerator,
  validate: {
    xForwardedForHeader: false,
  },
});

module.exports = {
  globalLimiter,
  sensitiveLimiter,
  apiKeyLimiter,
  parseRateLimitEnv,
  keyGenerator,
  apiKeyKeyGenerator,
  getApiKey,
};