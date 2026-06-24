'use strict';

const helmet = require('helmet');
const { securityHeaders } = require('../config');

/**
 * Security middleware factory.
 * Applies Helmet with the appropriate Content‑Security‑Policy based on the request path.
 * For Swagger/OpenAPI docs routes (`/api-docs` or `/docs`) a relaxed CSP is used to allow
 * inline scripts/styles required by the UI. All other routes receive the strict default CSP.
 * All other security headers are sourced from `securityHeaders` defined in the config module.
 *
 * @returns {import('express').RequestHandler}
 */
function createSecurityMiddleware() {
  return (req, res, next) => {
    const isDocs = req.path && (/^\/api-docs|\/docs/.test(req.path));

    const csp = isDocs ? securityHeaders.docsContentSecurityPolicy : securityHeaders.contentSecurityPolicy;

    // Helmet expects an options object; we spread the common options and inject the chosen CSP.
    const helmetOptions = {
      contentSecurityPolicy: csp,
      referrerPolicy: securityHeaders.referrerPolicy,
      hsts: securityHeaders.hsts,
      crossOriginEmbedderPolicy: { policy: 'require-corp' },
      crossOriginOpenerPolicy: { policy: 'same-origin' },
      crossOriginResourcePolicy: { policy: 'same-origin' },
      dnsPrefetchControl: { allow: false },
      frameguard: { action: 'deny' },
      hidePoweredBy: true,
      ieNoOpen: true,
      noSniff: true,
      originAgentCluster: true,
      permittedCrossDomainPolicies: { permittedPolicies: 'none' },
    };

    return helmet(helmetOptions)(req, res, next);
  };
}

/**
 * Explicit middleware for the documentation route.
 * This is kept for backward compatibility – it applies the docs‑specific CSP directly.
 *
 * @returns {import('express').RequestHandler}
 */
function createDocsSecurityMiddleware() {
  return (req, res, next) => {
    const helmetOptions = {
      contentSecurityPolicy: securityHeaders.docsContentSecurityPolicy,
      referrerPolicy: securityHeaders.referrerPolicy,
      hsts: securityHeaders.hsts,
      crossOriginEmbedderPolicy: { policy: 'require-corp' },
      crossOriginOpenerPolicy: { policy: 'same-origin' },
      crossOriginResourcePolicy: { policy: 'same-origin' },
      dnsPrefetchControl: { allow: false },
      frameguard: { action: 'deny' },
      hidePoweredBy: true,
      ieNoOpen: true,
      noSniff: true,
      originAgentCluster: true,
      permittedCrossDomainPolicies: { permittedPolicies: 'none' },
    };
    return helmet(helmetOptions)(req, res, next);
  };
}

module.exports = { createSecurityMiddleware, createDocsSecurityMiddleware };
