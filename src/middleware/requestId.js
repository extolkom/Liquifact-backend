'use strict';

/**
 * @fileoverview Middleware to attach a unique request ID to every request.
 *
 * This ensures that logs can be correlated across multiple middleware and services.
 * It checks for an existing X-Request-Id header (e.g., from a load balancer)
 * and generates a new one if missing.
 *
 * @module middleware/requestId
 */

const { randomUUID } = require('crypto');
const { createRequestLogger } = require('../logger');

/**
 * Attaches a unique request ID to the request and response objects.
 *
 * @param {import('express').Request} req - Express request object
 * @param {import('express').Response} res - Express response object
 * @param {import('express').NextFunction} next - Express next function
 */
const requestId = (req, res, next) => {
  // Use existing header if present (standard for distributed tracing)
  const id = req.headers['x-request-id'] || req.headers['request-id'] || randomUUID();

  // Attach to request object for use in subsequent middleware/handlers
  req.id = id;
  req.log = createRequestLogger(req);

  // Set the response header so clients/proxies can see the ID
  res.setHeader('X-Request-Id', id);

  next();
};

module.exports = requestId;
