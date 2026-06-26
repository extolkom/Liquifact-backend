'use strict';

/**
 * tests/apiKey.test.js
 *
 * Migration smoke tests verifying that the legacy SQLite-backed API key
 * middleware has been fully retired and all callers now use the env-registry
 * authenticator in src/middleware/apiKeyAuth.js.
 *
 * Deep coverage of authenticateApiKey + config/apiKeys lives in
 * tests/unit/apiKeyAuth.test.js. This file focuses on:
 *   - legacy module is gone (no sqlite3, no per-request DB connection)
 *   - the modern path handles the same scenarios the old test covered
 *   - stacks.js adminAuth uses the registry-backed middleware
 */

const request = require('supertest');
const express = require('express');
const { authenticateApiKey, API_KEY_HEADER } = require('../src/middleware/apiKeyAuth');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const VALID_KEY = 'lf_testmigr00001';
const REVOKED_KEY = 'lf_revokedkey001';
const SCOPED_KEY = 'lf_scopedkey0001';

const TEST_ENV = {
  API_KEYS: [
    JSON.stringify({ key: VALID_KEY, clientId: 'test-service', scopes: ['invoices:read', 'escrow:read'] }),
    JSON.stringify({ key: REVOKED_KEY, clientId: 'old-service', scopes: ['invoices:read'], revoked: true }),
    JSON.stringify({ key: SCOPED_KEY, clientId: 'scoped-service', scopes: ['invoices:write'] }),
  ].join(';'),
};

function makeApp(middleware) {
  const app = express();
  app.get('/protected', middleware, (req, res) => res.json({ ok: true, apiClient: req.apiClient }));
  app.use((err, req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

// ─── Legacy module is gone ────────────────────────────────────────────────────

describe('legacy apiKey.js is retired', () => {
  it('src/middleware/apiKey.js no longer exists', () => {
    expect(() => require('../src/middleware/apiKey')).toThrow();
  });

  it('does not expose initDb (no per-request SQLite connection)', () => {
    const mod = require('../src/middleware/apiKeyAuth');
    expect(mod.initDb).toBeUndefined();
  });

  it('does not export hashApiKey (raw SHA-256 key hashing is internal)', () => {
    const mod = require('../src/middleware/apiKeyAuth');
    expect(mod.hashApiKey).toBeUndefined();
  });
});

// ─── Modern path — missing header ─────────────────────────────────────────────

describe('authenticateApiKey — missing header', () => {
  const app = makeApp(authenticateApiKey({ env: TEST_ENV }));

  it('returns 401 when X-API-Key header is absent', async () => {
    const res = await request(app).get('/protected');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/API key is required/);
  });

  it('returns 401 when X-API-Key header is empty', async () => {
    const res = await request(app).get('/protected').set(API_KEY_HEADER, '');
    expect(res.status).toBe(401);
  });
});

// ─── Modern path — invalid key ────────────────────────────────────────────────

describe('authenticateApiKey — invalid key', () => {
  const app = makeApp(authenticateApiKey({ env: TEST_ENV }));

  it('returns 401 for an unrecognised key', async () => {
    const res = await request(app).get('/protected').set(API_KEY_HEADER, 'lf_unknownkey999');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Invalid API key/);
  });

  it('does not leak key material in the error response', async () => {
    const res = await request(app).get('/protected').set(API_KEY_HEADER, 'lf_secretvalue0');
    expect(JSON.stringify(res.body)).not.toContain('lf_secretvalue0');
  });
});

// ─── Modern path — revoked key ────────────────────────────────────────────────

describe('authenticateApiKey — revoked key', () => {
  const app = makeApp(authenticateApiKey({ env: TEST_ENV }));

  it('returns 401 for a revoked key', async () => {
    const res = await request(app).get('/protected').set(API_KEY_HEADER, REVOKED_KEY);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/revoked/);
  });
});

// ─── Modern path — valid key ──────────────────────────────────────────────────

describe('authenticateApiKey — valid key', () => {
  const app = makeApp(authenticateApiKey({ env: TEST_ENV }));

  it('returns 200 and populates req.apiClient', async () => {
    const res = await request(app).get('/protected').set(API_KEY_HEADER, VALID_KEY);
    expect(res.status).toBe(200);
    expect(res.body.apiClient).toMatchObject({
      clientId: 'test-service',
      scopes: expect.arrayContaining(['invoices:read', 'escrow:read']),
    });
  });

  it('accepts key with surrounding whitespace', async () => {
    const res = await request(app).get('/protected').set(API_KEY_HEADER, `  ${VALID_KEY}  `);
    expect(res.status).toBe(200);
  });
});

// ─── Modern path — wrong scope ────────────────────────────────────────────────

describe('authenticateApiKey — scope enforcement', () => {
  it('returns 403 when the key lacks the required scope', async () => {
    const app = makeApp(authenticateApiKey({ requiredScope: 'invoices:write', env: TEST_ENV }));
    // VALID_KEY only has invoices:read and escrow:read
    const res = await request(app).get('/protected').set(API_KEY_HEADER, VALID_KEY);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Insufficient permissions/);
  });

  it('returns 200 when the key has the required scope', async () => {
    const app = makeApp(authenticateApiKey({ requiredScope: 'invoices:write', env: TEST_ENV }));
    const res = await request(app).get('/protected').set(API_KEY_HEADER, SCOPED_KEY);
    expect(res.status).toBe(200);
  });
});

// ─── Modern path — malformed registry ────────────────────────────────────────

describe('authenticateApiKey — malformed registry', () => {
  it('surfaces a 500 when API_KEYS contains invalid JSON', async () => {
    const app = makeApp(authenticateApiKey({ env: { API_KEYS: '{broken' } }));
    const res = await request(app).get('/protected').set(API_KEY_HEADER, VALID_KEY);
    expect(res.status).toBe(500);
  });
});

// ─── Timing-safe comparison (no short-circuit) ───────────────────────────────

describe('authenticateApiKey — timing-safe lookup', () => {
  it('uses constant-time comparison (always evaluates all registry entries)', async () => {
    const multiEnv = {
      API_KEYS: [
        JSON.stringify({ key: 'lf_alpha00000001', clientId: 'svc-alpha', scopes: ['invoices:read'] }),
        JSON.stringify({ key: 'lf_beta000000001', clientId: 'svc-beta', scopes: ['invoices:read'] }),
        JSON.stringify({ key: 'lf_gamma00000001', clientId: 'svc-gamma', scopes: ['invoices:read'] }),
      ].join(';'),
    };
    const app = makeApp(authenticateApiKey({ env: multiEnv }));

    const r1 = await request(app).get('/protected').set(API_KEY_HEADER, 'lf_alpha00000001');
    expect(r1.body.apiClient.clientId).toBe('svc-alpha');

    const r2 = await request(app).get('/protected').set(API_KEY_HEADER, 'lf_gamma00000001');
    expect(r2.body.apiClient.clientId).toBe('svc-gamma');
  });
});
