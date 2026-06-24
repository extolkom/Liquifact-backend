/**
 * @fileoverview RFC 7807 Problem Details middleware for Express.
 *
 * Implements standardized problem+json error responses with type, title, status,
 * and optional instance fields. Provides secure error handling with request
 * correlation and proper content-type negotiation.
 *
 * @see https://tools.ietf.org/html/rfc7807
 * @module middleware/problemJson
 */

"use strict";

const AppError = require("../errors/AppError");
const { mapError } = require("../errors/mapError");
const logger = require("../logger");
const formatProblemDetails = require("../utils/problemDetails");

// Re-export constants and helpers from the canonical problemDetails module
const getProblemType = formatProblemDetails.getProblemType;
const getStandardTitle = formatProblemDetails.getStandardTitle;
const DEFAULT_PROBLEM_TYPE = formatProblemDetails.DEFAULT_PROBLEM_TYPE;
const LIQUifact_PROBLEM_BASE = formatProblemDetails.LIQUifact_PROBLEM_BASE;

/**
 * Creates a RFC 7807 compliant problem details object.
 *
 * @param {Object} options - Problem details options
 * @param {string} options.type - Problem type URI
 * @param {string} options.title - Short, human-readable summary
 * @param {number} options.status - HTTP status code
 * @param {string} options.detail - Human-readable explanation
 * @param {string} [options.instance] - URI identifying specific occurrence
 * @param {string} [options.requestId] - Request correlation ID
 * @returns {Object} RFC 7807 problem details object
 */
function createProblemDetails({
  type,
  title,
  status = 500,
  detail,
  instance,
  requestId,
}) {
  const resolvedType = type || getProblemType(status);
  const resolvedTitle = title || "An error occurred";

  let resolvedInstance = instance;
  if (!resolvedInstance && requestId) {
    resolvedInstance = `urn:uuid:${requestId}`;
  }

  return formatProblemDetails({
    type: resolvedType,
    title: resolvedTitle,
    status,
    detail,
    instance: resolvedInstance,
  });
}

/**
 * Express middleware that handles errors and returns RFC 7807 problem+json responses.
 *
 * Features:
 * - Proper Content-Type: application/problem+json
 * - Request correlation via instance field or X-Request-ID header
 * - Secure error handling (no stack traces in production)
 * - Support for AppError instances and generic errors
 * - Comprehensive logging with correlation context
 *
 * @param {Error|unknown} error - The error that occurred
 * @param {import('express').Request} req - Express request object
 * @param {import('express').Response} res - Express response object
 * @param {import('express').NextFunction} _next - Express next function (unused)
 * @returns {void}
 */
function problemJsonHandler(error, req, res, _next) {
  const requestId = req.id || req.headers["x-request-id"] || "unknown";

  // Log the error with full context
  logError(error, requestId, req);

  // Map the error to a standardized format
  const mappedError = mapError(error);

  // Use robust isAppError check to handle potential class instances from different caches (due to jest.resetModules())
  const isAppError =
    error && (error instanceof AppError || error.name === "AppError");

  const status = mappedError.status;
  const resolvedType =
    isAppError && error.type !== "about:blank"
      ? error.type
      : getProblemType(status);
  const resolvedTitle = isAppError
    ? error.title && error.title !== "An unexpected error occurred"
      ? error.title
      : getStandardTitle(status)
    : mappedError.message;

  // Create RFC 7807 problem details by delegating to formatProblemDetails
  const problemDetails = formatProblemDetails({
    type: resolvedType,
    title: resolvedTitle,
    status,
    detail: mappedError.message,
    // Only pass instance if explicitly set on AppError, otherwise let it default to requestId
    instance:
      isAppError && error.instance ? error.instance : `urn:uuid:${requestId}`,
    code: isAppError ? error.code : undefined,
    retryable: isAppError ? error.retryable : undefined,
    retryHint: isAppError ? error.retryHint : undefined,
  });

  // Set content type for problem+json
  res.setHeader("Content-Type", "application/problem+json");

  // Send problem details response
  res.status(status).json(problemDetails);
}

/**
 * Logs errors with correlation context without exposing sensitive information.
 *
 * @param {Error|unknown} error - The error to log
 * @param {string} requestId - Request correlation ID
 * @param {import('express').Request} req - Express request object
 * @returns {void}
 */
function logError(error, requestId, req) {
  const isDevelopment = process.env.NODE_ENV === "development";
  const isAppError =
    error && (error instanceof AppError || error.name === "AppError");

  const logContext = {
    requestId,
    method: req.method,
    url: req.originalUrl,
    userAgent: req.headers["user-agent"],
    ip: req.ip || req.connection.remoteAddress,
  };

  // Include error details in development
  if (isDevelopment) {
    logContext.err = error;
    if (error instanceof Error && error.stack) {
      logContext.stack = error.stack;
    }
  } else {
    // In production, only include safe error information
    logContext.errorName = error instanceof Error ? error.name : "Unknown";
    logContext.errorMessage = isAppError
      ? error.detail || error.message
      : error instanceof Error
        ? error.message
        : "Non-error thrown";
    logContext.errorCode = isAppError ? error.code : undefined;
  }

  const message = isAppError
    ? error.detail || error.message
    : error instanceof Error
      ? error.message
      : "Non-error value thrown";

  if (isAppError && error.status < 500) {
    // Client errors (4xx) - log as warning
    logger.warn(logContext, `Client error: ${message}`);
  } else {
    // Server errors (5xx) - log as error
    logger.error(logContext, `Server error: ${message}`);
  }
}

/**
 * Express 404 handler that creates a proper problem details response.
 *
 * @param {import('express').Request} req - Express request object
 * @param {import('express').Response} _res - Express response object
 * @param {import('express').NextFunction} next - Express next function
 * @returns {void}
 */
function notFoundHandler(req, _res, next) {
  next(
    new AppError({
      type: getProblemType(404),
      title: "Not Found",
      status: 404,
      detail: `The requested resource ${req.method} ${req.originalUrl} was not found.`,
      instance: req.originalUrl,
    }),
  );
}

/**
 * Middleware factory that creates a problem+json error handler with custom options.
 *
 * @param {Object} [options={}] - Configuration options
 * @param {string} [options.problemBase] - Base URI for problem types
 * @param {boolean} [options.includeStackInDev=true] - Include stack traces in development
 * @returns {Function} Express error handler middleware
 */
function createProblemJsonHandler(options = {}) {
  const { _problemBase = LIQUifact_PROBLEM_BASE, _includeStackInDev = true } =
    options;

  return (error, req, res, next) => {
    // Custom configuration can be handled here
    problemJsonHandler(error, req, res, next);
  };
}

module.exports = {
  problemJsonHandler,
  createProblemJsonHandler,
  notFoundHandler,
  createProblemDetails,
  getProblemType,
  DEFAULT_PROBLEM_TYPE,
  LIQUifact_PROBLEM_BASE,
};
