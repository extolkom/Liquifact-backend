'use strict';

/**
 * @fileoverview Logger utility using Pino for structured JSON logging.
 *
 * Provides a consistent logging interface with support for:
 * - Structured JSON output (for production log aggregation)
 * - Pretty printing (for local development)
 * - Standardized log levels
 * - Request correlation via request IDs
 *
 * @module logger
 */

const pino = require('pino');

/**
 * Configure the Pino logger instance.
 *
 * In production, this outputs raw JSON. In development (when NODE_ENV is not 'production'),
 * it can use pino-pretty if available.
 */
const transport =
  process.env.NODE_ENV !== 'production'
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined;

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: {
    service: 'liquifact-api',
    env: process.env.NODE_ENV || 'development',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => {
      return { level: label.toUpperCase() };
    },
  },
}, transport ? pino.transport(transport) : undefined);

/**
 * Create a per-request child logger bound only with safe correlation fields.
 *
 * @param {import('express').Request | undefined} req - Express request object.
 * @returns {import('pino').Logger} A child logger scoped to the request.
 */
function createRequestLogger(req) {
  const bindings = {};

  if (typeof req?.id === 'string' && req.id) {
    bindings.requestId = req.id;
  }

  if (typeof req?.correlationId === 'string' && req.correlationId) {
    bindings.correlationId = req.correlationId;
  }

  return logger.child(bindings);
}

logger.createRequestLogger = createRequestLogger;

module.exports = logger;
module.exports.createRequestLogger = createRequestLogger;
