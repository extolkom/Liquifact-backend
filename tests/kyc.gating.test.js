'use strict';

/**
 * tests/kyc.gating.test.js
 *
 * Tests for requireKycForFunding middleware (src/middleware/kycGating.js).
 *
 * Security contract enforced:
 *   1. smeId is resolved ONLY from req.user (JWT claim) — body/params cannot
 *      override it, preventing KYC-bypass via smeId spoofing.
 *   2. Unauthenticated callers get 401.
 *   3. Principals with no smeId claim get 400.
 *   4. Pending/rejected KYC → 403 KYC_GATE_FAILED.
 *   5. Verified/exempted KYC → passes through; req.kyc is correctly populated.
 */

// ─── Knex mock ─────────────────────────────────────────────────────────────
// kyc_records DB queries must return null so the service falls back to the
// in-memory mockKycRecords store (which we control via kycService helpers).
jest.mock('../src/db/knex', () => {
  const chain = {
    where: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(null),
    insert: jest.fn().mockResolvedValue([{ id: 'mock-id' }]),
    returning: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
  };
  const knex = jest.fn(() => chain);
  knex.fn = { now: jest.fn() };
  return knex;
});

const request = require('supertest');
const express = require('express');
const kycService = require('../src/services/kycService');
const { requireKycForFunding } = require('../src/middleware/kycGating');

// ─── Test app factory ──────────────────────────────────────────────────────

/**
 * Build a minimal Express app:
 *   - optionally sets req.user (pass null → unauthenticated)
 *   - mounts requireKycForFunding
 *   - echoes req.kyc in the success response
 *   - serialises AppError fields in the error handler
 *
 * @param {{ sub?: string, smeId?: string }|null} user
 */
function buildApp(user) {
  const app = express();
  app.use(express.json());

  app.use((req, res, next) => {
    if (user !== null) req.user = user;
    req.id = 'req-test';
    next();
  });

  app.post('/fund', requireKycForFunding, (req, res) => {
    res.json({ ok: true, kyc: req.kyc });
  });

  // Serialise AppError so tests can inspect `code` and `message`
  app.use((err, req, res, _next) => {
    res.status(err.status || 500).json({
      error: {
        code:    err.code    || 'UNKNOWN_ERROR',
        message: err.detail  || err.message,
        type:    err.type,
      },
    });
  });

  return app;
}

// ─── Authentication guard ──────────────────────────────────────────────────

describe('requireKycForFunding — authentication guard', () => {
  it('returns 401 when req.user is absent (unauthenticated)', async () => {
    const res = await request(buildApp(null)).post('/fund').send({});
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 when req.user exists but has no sub', async () => {
    const res = await request(buildApp({ smeId: 'some-sme' })).post('/fund').send({});
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

// ─── smeId resolution — spoof prevention ──────────────────────────────────

describe('requireKycForFunding — smeId must come from JWT', () => {
  it('returns 400 when JWT has no smeId claim', async () => {
    const res = await request(buildApp({ sub: 'u-nosme' })).post('/fund').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MISSING_SME_ID');
  });

  it('returns 400 when JWT smeId is an empty string', async () => {
    const res = await request(buildApp({ sub: 'u-empty', smeId: '' })).post('/fund').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MISSING_SME_ID');
  });

  it('body smeId cannot grant access — JWT smeId (pending) still blocks', async () => {
    // JWT has PENDING smeId; body carries a VERIFIED smeId. Must still be 403.
    const pendingId = 'sme-spoof-body-pending';
    const verifiedId = 'sme-spoof-body-verified';
    await kycService.verifySmeSafe(verifiedId);

    const res = await request(buildApp({ sub: 'u-body-spoof', smeId: pendingId }))
      .post('/fund')
      .send({ smeId: verifiedId });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('KYC_GATE_FAILED');
  });

  it('req.kyc.smeId equals JWT smeId, not body smeId', async () => {
    // JWT: VERIFIED. Body: attacker-controlled value. Confirm req.kyc reflects JWT.
    const verifiedId = 'sme-kyc-echo-verified';
    await kycService.verifySmeSafe(verifiedId);

    const res = await request(buildApp({ sub: 'u-kyc-echo', smeId: verifiedId }))
      .post('/fund')
      .send({ smeId: 'attacker-sme' });

    expect(res.status).toBe(200);
    expect(res.body.kyc.smeId).toBe(verifiedId);
    expect(res.body.kyc.smeId).not.toBe('attacker-sme');
  });

  it('query-param smeId cannot grant access — JWT smeId (pending) still blocks', async () => {
    const pendingId  = 'sme-spoof-query-pending';
    const verifiedId = 'sme-spoof-query-verified';
    await kycService.verifySmeSafe(verifiedId);

    const res = await request(buildApp({ sub: 'u-qparam-spoof', smeId: pendingId }))
      .post(`/fund?smeId=${verifiedId}`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('KYC_GATE_FAILED');
  });
});

// ─── KYC status enforcement ────────────────────────────────────────────────

describe('requireKycForFunding — KYC status enforcement', () => {
  it('returns 403 for pending KYC (unknown / unregistered SME)', async () => {
    // Not registered → getKycStatus returns { status: 'pending' }
    const res = await request(buildApp({ sub: 'u-pending', smeId: 'sme-status-pending-unknown' }))
      .post('/fund')
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('KYC_GATE_FAILED');
    expect(res.body.error.message).toMatch(/pending/);
  });

  it('returns 403 for explicitly rejected KYC', async () => {
    const rejectedId = 'sme-status-rejected';
    await kycService.rejectSmeKyc(rejectedId, 'unit test rejection');

    const res = await request(buildApp({ sub: 'u-rejected', smeId: rejectedId }))
      .post('/fund')
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('KYC_GATE_FAILED');
    expect(res.body.error.message).toMatch(/rejected/);
  });

  it('passes through for verified KYC', async () => {
    const verifiedId = 'sme-status-verified';
    await kycService.verifySmeSafe(verifiedId);

    const res = await request(buildApp({ sub: 'u-verified', smeId: verifiedId }))
      .post('/fund')
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('passes through for exempted KYC', async () => {
    const exemptedId = 'sme-status-exempted';
    await kycService.exemptSmeFromKyc(exemptedId);

    const res = await request(buildApp({ sub: 'u-exempted', smeId: exemptedId }))
      .post('/fund')
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ─── req.kyc shape ────────────────────────────────────────────────────────

describe('requireKycForFunding — req.kyc is populated on pass-through', () => {
  it('attaches smeId, status, recordId, and verifiedAt for verified principal', async () => {
    const smeId = 'sme-shape-verified';
    await kycService.verifySmeSafe(smeId);

    const res = await request(buildApp({ sub: 'u-kyc-shape', smeId }))
      .post('/fund')
      .send({});
    expect(res.status).toBe(200);
    const { kyc } = res.body;
    expect(kyc.smeId).toBe(smeId);
    expect(kyc.status).toBe('verified');
    expect(kyc.recordId).toBeDefined();
    expect(kyc.verifiedAt).toBeDefined();
  });

  it('attaches status exempted for exempted principal', async () => {
    const smeId = 'sme-shape-exempted';
    await kycService.exemptSmeFromKyc(smeId);

    const res = await request(buildApp({ sub: 'u-kyc-exempt-shape', smeId }))
      .post('/fund')
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.kyc.status).toBe('exempted');
  });
});

// ─── kycService.canFundWithKycStatus ──────────────────────────────────────

describe('kycService.canFundWithKycStatus', () => {
  it.each([
    ['verified',  true],
    ['exempted',  true],
    ['pending',   false],
    ['rejected',  false],
  ])('returns %s for status "%s"', (status, expected) => {
    expect(kycService.canFundWithKycStatus(status)).toBe(expected);
  });
});
