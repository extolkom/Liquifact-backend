'use strict';

const { createRequestLogger } = require('../logger');
const {
  CORRELATION_HEADER,
  REQUEST_IDENTIFIER_PATTERN,
  generateRequestIdentifier,
  resolveRequestIdentifierFromHeaders,
  resolveRequestIdentifierFromRequest,
} = require('./requestIdentifier');

/**
 * Attach a validated correlation ID to the request and response.
 *
 * @param {import('express').Request} req Request object.
 * @param {import('express').Response} res Response object.
 * @param {import('express').NextFunction} next Next middleware.
 * @returns {void}
 */
function correlationIdMiddleware(req, res, next) {
  const correlationId =
    resolveRequestIdentifierFromRequest(req) ||
    resolveRequestIdentifierFromHeaders(req.headers) ||
    generateRequestIdentifier();

  req.id = correlationId;
  req.correlationId = correlationId;
  req.log = createRequestLogger(req);
  res.setHeader('X-Request-Id', correlationId);
  res.setHeader('X-Correlation-Id', correlationId);
  next();
}

module.exports = {
  CORRELATION_HEADER,
  CORRELATION_ID_PATTERN: REQUEST_IDENTIFIER_PATTERN,
  correlationIdMiddleware,
};
