'use strict';

const SENTRY_DSN = process.env.SENTRY_DSN && process.env.SENTRY_DSN.trim();
let Sentry = null;
let enabled = false;

const SENSITIVE_FIELD_NAMES = [
  'authorization',
  'auth',
  'token',
  'password',
  'secret',
  'x-api-key',
  'api-key',
  'xdr',
  'stellar',
  'invoice',
];

const REDACTED = '[REDACTED]';
const REDACTED_INVOICE = '[REDACTED-INVOICE]';

/**
 * Checks if a given key is considered sensitive.
 * @param {string} key The key to check.
 * @returns {boolean} True if the key is sensitive.
 */
function isSensitiveField(key) {
  if (!key || typeof key !== 'string') {
    return false;
  }

  return SENSITIVE_FIELD_NAMES.some((name) => key.toLowerCase().includes(name));
}

/**
 * Redacts a value if it is associated with a sensitive key or looks like a token.
 * @param {string} key The key associated with the value.
 * @param {any} value The value to potentially redact.
 * @returns {any} The redacted or original value.
 */
function redactValue(key, value) {
  if (value == null) {
    return value;
  }

  if (isSensitiveField(key)) {
    return key.toLowerCase().includes('invoice') ? REDACTED_INVOICE : REDACTED;
  }

  if (typeof value === 'string') {
    if (looksLikeSensitiveToken(value)) {
      return REDACTED;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(key, item));
  }

  if (typeof value === 'object') {
    return scrubObject(value);
  }

  return value;
}

/**
 * Checks if a string value looks like a sensitive token (e.g., JWT, Bearer token).
 * @param {any} value The value to check.
 * @returns {boolean} True if it looks like a sensitive token.
 */
function looksLikeSensitiveToken(value) {
  if (typeof value !== 'string') {
    return false;
  }

  const tokenPatterns = [
    /Bearer\s+[A-Za-z0-9\-_.]+/i,
    /(?:eyJ|AAAA)[A-Za-z0-9_-]{20,}/,
    /[A-Za-z0-9-_]{40,}/,
  ];

  return tokenPatterns.some((pattern) => pattern.test(value));
}

/**
 * Recursively scrubs sensitive fields from an object.
 * @param {Object|Array} obj The object or array to scrub.
 * @returns {Object|Array} The scrubbed object or array.
 */
function scrubObject(obj) {
  if (obj == null || typeof obj !== 'object') {
    return obj;
  }

  const output = Array.isArray(obj) ? [] : {};

  for (const key of Object.keys(obj)) {
    const value = obj[key];

    if (isSensitiveField(key)) {
      output[key] = redactValue(key, value);
      continue;
    }

    output[key] = redactValue(key, value);
  }

  return output;
}

/**
 * Scrubs sensitive fields from a headers object.
 * @param {Object} headers The headers object to scrub.
 * @returns {Object} The scrubbed headers object.
 */
function scrubHeaders(headers) {
  if (!headers || typeof headers !== 'object') {
    return headers;
  }

  const scrubbed = {};
  for (const [key, value] of Object.entries(headers)) {
    if (isSensitiveField(key)) {
      scrubbed[key] = REDACTED;
      continue;
    }
    scrubbed[key] = redactValue(key, value);
  }

  return scrubbed;
}

/**
 * Scrubs sensitive information from a Sentry event.
 * @param {Object} event The Sentry event object.
 * @returns {Object} The scrubbed event object.
 */
function scrubEvent(event) {
  if (!event || typeof event !== 'object') {
    return event;
  }

  const safeEvent = { ...event };

  if (safeEvent.request && typeof safeEvent.request === 'object') {
    safeEvent.request = { ...safeEvent.request };

    if (safeEvent.request.headers) {
      safeEvent.request.headers = scrubHeaders(safeEvent.request.headers);
    }

    if (safeEvent.request.data) {
      safeEvent.request.data = scrubObject(safeEvent.request.data);
    }

    if (safeEvent.request.url) {
      safeEvent.request.url = safeEvent.request.url;
    }
  }

  if (safeEvent.extra) {
    safeEvent.extra = scrubObject(safeEvent.extra);
  }

  if (safeEvent.user) {
    safeEvent.user = scrubObject(safeEvent.user);
  }

  if (safeEvent.tags) {
    safeEvent.tags = scrubObject(safeEvent.tags);
  }

  return safeEvent;
}

/**
 * Initializes Sentry with the configured DSN and settings.
 * @returns {void}
 */
function initSentry() {
  if (!SENTRY_DSN) {
    return;
  }

  try {
    Sentry = require('@sentry/node');

    Sentry.init({
      dsn: SENTRY_DSN,
      release: process.env.SENTRY_RELEASE || process.env.npm_package_version || 'liquifact-backend@unknown',
      environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
      attachStacktrace: true,
      normalizeDepth: 5,
      beforeSend: scrubEvent,
      beforeSendTransaction: scrubEvent,
    });

    enabled = true;
  } catch (err) {
    enabled = false;
    // Avoid breaking startup if Sentry cannot be loaded or initialized.
     
    console.warn('Sentry initialization failed:', err.message || err);
  }
}

/**
 * Returns the Sentry request handler middleware.
 * @returns {import('express').RequestHandler} Express middleware.
 */
function requestHandler() {
  if (!enabled || !Sentry || !Sentry.Handlers || !Sentry.Handlers.requestHandler) {
    return (req, res, next) => next();
  }

  return Sentry.Handlers.requestHandler();
}

/**
 * Captures an exception and sends it to Sentry, including request context if provided.
 * @param {Error} error The exception to capture.
 * @param {import('express').Request} [req] The Express request object.
 * @returns {void}
 */
function captureException(error, req) {
  if (!enabled || !Sentry || !Sentry.withScope || !Sentry.captureException) {
    return;
  }

  Sentry.withScope((scope) => {
    if (req && scope) {
      const setTag = scope.setTag ? scope.setTag.bind(scope) : () => {};
      const setExtra = scope.setExtra ? scope.setExtra.bind(scope) : () => {};
      const setUser = scope.setUser ? scope.setUser.bind(scope) : () => {};

      setTag('request_id', req.id || 'unknown');
      setTag('method', req.method || 'unknown');
      setTag('url', req.originalUrl || req.url || 'unknown');
      setExtra('headers', scrubHeaders(req.headers || {}));
      setExtra('query', scrubObject(req.query || {}));
      setExtra('body', scrubObject(req.body || {}));
      if (req.user) {
        setUser(scrubObject(req.user));
      }
    }

    Sentry.captureException(error);
  });
}

module.exports = {
  initSentry,
  requestHandler,
  captureException,
  isEnabled: () => enabled,
  scrubEvent,
};
