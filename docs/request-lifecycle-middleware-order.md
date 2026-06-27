# Request lifecycle and middleware order

This document describes how incoming HTTP requests flow through the LiquiFact
Express application and the intended order of global middleware and feature-router
mounts in [`src/app.js`](../src/app.js).

## Global middleware (every request)

Applied in this order before any route handler runs:

| Step | Middleware | Purpose |
|------|------------|---------|
| 1 | CORS (`createCorsOptions`) | Environment-driven origin allowlist |
| 1.a | Raw body parser (`/api/kyc/webhook` only) | Provider webhook signature verification |
| 2 | JSON body limit | Global JSON payload guardrail (100 KB) |
| 3 | URL-encoded body limit | Form payloads (50 KB) |
| 4 | Security headers (`createSecurityMiddleware`) | Helmet-style hardening |
| 5 | Audit middleware | Structured request audit trail |
| 6 | Request ID | Propagates `req.id` for logging |
| 7 | Correlation ID | Cross-service trace correlation |

## Inline routes (defined on `app` directly)

Health probes (`/health`, `/healthz`, `/ready`, `/readyz`), API info (`/api`),
invoice list/create, escrow read, and debug error routes are registered on the
app instance before feature routers mount.

## Feature router mounts (single mount per router instance)

Each feature router is imported once and mounted once via
`mountFeatureRouter` from [`src/utils/routeMountRegistry.js`](../src/utils/routeMountRegistry.js).
A startup assertion (`assertNoDuplicateRouterMounts`) fails fast if the same
router instance is mounted twice at the same base path.

Mount order (preserved intentionally):

| Order | Base path | Router module | Notes |
|-------|-----------|---------------|-------|
| 1 | `/api/sme` | `routes/sme` | SME metrics and uploads |
| 2 | `/api/invoices` | `routes/invoiceFile` | File upload handlers |
| 3 | `/api/invoices` | `routes/invoiceStateRoutes` | State machine (second router, different instance) |
| 4 | `/api/invest` | `routes/invest` | Funding opportunities and fund-invoice |
| 5 | `/api/investor` | `routes/investor` | **Single mount** — investor lock list/detail |
| 6 | `/api/kyc` | `routes/kyc` | KYC verification |
| 7 | `/api/marketplace` | `routes/marketplace` | Investable invoice marketplace |
| 8 | `/api/retention` | `routes/retention` | Data retention policies |
| 9 | `/api/admin/audit` | `routes/auditTrail` | Admin audit trail |
| 10 | `/api/admin/escrow` | `routes/adminEscrow` | Admin escrow tooling |
| 11 | `/api/admin/reconciliation` | `routes/reconciliation` | Reconciliation runs |
| 12 | `/v1` | `routes/v1` | Versioned API surface |

> **Investor routes:** `/api/investor` is mounted exactly once. The investor
> router applies `authenticateToken` then `extractTenant` on each handler, so
> auth and tenant context are enforced before lock list or detail logic runs.

## Post-route middleware

| Step | Handler | Purpose |
|------|---------|---------|
| Metrics | `GET /metrics` | Prometheus scrape (auth-gated) |
| 404 | Catch-all | Unknown paths |
| Error | CORS → payload-too-large → internal | Ordered error normalization |

## Standardized response envelope

Production entry points use `createStandardizedApp()`, which wraps `createApp()`
and normalizes JSON responses through `toStandardEnvelope`. Route order inside
`createApp()` is unchanged; only the outer response wrapper is added.
