'use strict';

/**
 * @fileoverview Middleware to attach a unique request ID to every request.
 *
 * This ensures that logs can be correlated across multiple middleware and services.
 * It checks for an existing X-Request-Id header (e.g., from a load balancer)
 * and generates a fresh, server-side UUID when the client value is missing or
 * unacceptable.
 *
 * Security: a client-supplied request id is only trusted when it matches a
 * strict charset and length bound. This prevents log forging (injection of
 * newlines / control characters into structured log lines) and resource
 * amplification (multi-kilobyte ids duplicated across every log entry and the
 * response header).
 *
 * @module middleware/requestId
 */

const { randomUUID } = require('crypto');
const { createRequestLogger } = require('../logger');
const { run } = require('../requestContext');
const REQUEST_ID_HEADER_NAMES = ['x-request-id', 'request-id'];

/**
 * Maximum accepted length, in characters, for a client-supplied request id.
 * Values longer than this are rejected and replaced with a generated id.
 *
 * @type {number}
 */
const MAX_REQUEST_ID_LENGTH = 128;

/**
 * Strict charset for an acceptable inbound request id.
 *
 * Only unreserved URL characters are allowed (`[A-Za-z0-9._-]`), which excludes
 * whitespace, newlines (CR/LF), and all control characters that would otherwise
 * be vectors for log injection. The bound `{1,128}` also rejects empty and
 * oversized values.
 *
 * @type {RegExp}
 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Validate and sanitize a client-supplied request id.
 *
 * Returns the value unchanged only when it is a non-empty string within the
 * length bound and composed exclusively of the allowed charset. Any other
 * input - a non-string (e.g. a repeated header parsed as an array), an empty
 * string, an oversized string, or a string containing control characters,
 * newlines, or other disallowed bytes - yields `null`, signalling that a fresh
 * server-generated id must be used instead.
 *
 * @param {unknown} value - Candidate request id taken from an inbound header.
 * @returns {string|null} The validated id, or `null` when it must be replaced.
 */
function sanitizeRequestId(value) {
  if (typeof value !== 'string') {
    return null;
  }

  // Cheap length guard first so oversized payloads never reach the regex.
  if (value.length === 0 || value.length > MAX_REQUEST_ID_LENGTH) {
    return null;
  }

  if (!REQUEST_ID_PATTERN.test(value)) {
    return null;
  }

  return value;
}

/**
 * Generate a fresh, full-strength server-side request id.
 *
 * Uses a v4 UUID (122 bits of entropy) so fallback ids are as strong as the
 * fallback used by {@link module:middleware/correlationId}.
 *
 * @returns {string} A newly generated UUID.
 */
function generateRequestId() {
  return randomUUID();
}

/**
 * Resolve the first acceptable request id from supported inbound header names.
 *
 * @param {NodeJS.Dict<string | string[]> | undefined} headers - Inbound request headers.
 * @returns {string|null} The first validated request id, or `null` when none are acceptable.
 */
function resolveRequestIdFromHeaders(headers) {
  for (const headerName of REQUEST_ID_HEADER_NAMES) {
    const value = sanitizeRequestId(headers?.[headerName]);
    if (value) {
      return value;
    }
  }

  return null;
}

/**
 * Attaches a validated, bounded request ID to the request and response objects.
 *
 * The single sanitized id is the only value carried into the child logger
 * (`req.log`) and echoed in the `X-Request-Id` response header, so no
 * untrusted bytes ever reach a log sink or a downstream client.
 *
 * @param {import('express').Request} req - Express request object
 * @param {import('express').Response} res - Express response object
 * @param {import('express').NextFunction} next - Express next function
 */
const requestId = (req, res, next) => {
  // Prefer a validated client-supplied id (standard for distributed tracing),
  // otherwise fall back to a fresh server-generated id.
  const id = resolveRequestIdFromHeaders(req.headers) || generateRequestId();

  // Attach to request object for use in subsequent middleware/handlers.
  req.id = id;
  req.log = createRequestLogger(req);

  // Echo the validated id so clients/proxies can see it.
  res.setHeader('X-Request-Id', id);

  // Seed the AsyncLocalStorage context so all downstream async work
  // (services, jobs dispatched within the request) automatically inherit it.
  run({ requestId: id }, next);
};

module.exports = requestId;
module.exports.sanitizeRequestId = sanitizeRequestId;
module.exports.generateRequestId = generateRequestId;
module.exports.resolveRequestIdFromHeaders = resolveRequestIdFromHeaders;
module.exports.MAX_REQUEST_ID_LENGTH = MAX_REQUEST_ID_LENGTH;
module.exports.REQUEST_ID_PATTERN = REQUEST_ID_PATTERN;

