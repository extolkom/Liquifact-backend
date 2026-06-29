'use strict';

const { randomUUID } = require('crypto');
const { createRequestLogger } = require('../logger');
const { set: setContext } = require('../requestContext');

const CORRELATION_HEADER = 'x-correlation-id';
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Attach a validated correlation ID to the request and response.
 *
 * @param {import('express').Request} req Request object.
 * @param {import('express').Response} res Response object.
 * @param {import('express').NextFunction} next Next middleware.
 * @returns {void}
 */
function correlationIdMiddleware(req, res, next) {
  const candidate = req.header(CORRELATION_HEADER);
  // Fallback uses the full UUID (no truncation) so the generated id keeps its
  // full entropy, matching the strength of the requestId middleware fallback.
  // `req_` + 32 hex chars = 36 chars, within the accepted {8,64} bound.
  const correlationId =
    typeof candidate === 'string' && CORRELATION_ID_PATTERN.test(candidate)
      ? candidate
      : `req_${randomUUID().replace(/-/g, '')}`;

  req.correlationId = correlationId;
  req.log = createRequestLogger(req);
  res.setHeader('X-Correlation-Id', correlationId);
  // Merge into the existing AsyncLocalStorage context (seeded by requestId middleware).
  setContext({ correlationId });
  next();
}

module.exports = {
  CORRELATION_HEADER,
  correlationIdMiddleware,
};
