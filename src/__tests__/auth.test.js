'use strict';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { authenticateToken } = require('../middleware/auth');

// Build a self-contained Express app so the middleware can be tested in isolation
// without spinning up the full application stack.
const app = express();
app.use(express.json());

app.post('/api/invoices', authenticateToken, (req, res) => {
  res.status(201).json({ data: { id: 'placeholder' } });
});

app.get('/api/escrow/:invoiceId', authenticateToken, (req, res) => {
  res.status(200).json({ data: { invoiceId: req.params.invoiceId } });
});

app.use((err, req, res, _next) => {
  res.status(err.status || 500).json({
    type: err.type,
    title: err.title,
    status: err.status || 500,
    detail: err.detail || err.message,
    instance: err.instance,
  });
});

// RSA key pair used for algorithm-confusion tests
const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

describe('Authentication Middleware', () => {
  const secret = process.env.JWT_SECRET || 'test-secret';
  const validPayload = { id: 1, role: 'user' };
  let validToken;
  let expiredToken;

  beforeAll(() => {
    validToken = jwt.sign(validPayload, secret, { expiresIn: '1h' });
    expiredToken = jwt.sign(validPayload, secret, { expiresIn: '-1h' });
  });

  // ─── Route Protection — POST /api/invoices ────────────────────────────────

  describe('Route Protection — POST /api/invoices', () => {
    it('should return 401 when no token is provided', async () => {
      const res = await request(app).post('/api/invoices').send({});
      expect(res.status).toBe(401);
      expect(res.body.detail).toBe('Authentication token is required');
    });

    it('should return 401 when token format is invalid (missing Bearer)', async () => {
      const res = await request(app)
        .post('/api/invoices')
        .set('Authorization', `FakeBearer ${validToken}`)
        .send({});
      expect(res.status).toBe(401);
      expect(res.body.detail).toBe('Invalid Authorization header format. Expected "Bearer <token>"');
    });

    it('should return 401 when authorization header is malformed (no space)', async () => {
      const res = await request(app)
        .post('/api/invoices')
        .set('Authorization', `Bearer${validToken}`)
        .send({});
      expect(res.status).toBe(401);
      expect(res.body.detail).toBe('Invalid Authorization header format. Expected "Bearer <token>"');
    });

    it('should return 401 when token is invalid', async () => {
      const res = await request(app)
        .post('/api/invoices')
        .set('Authorization', 'Bearer some.invalid.token')
        .send({});
      expect(res.status).toBe(401);
      expect(res.body.detail).toBe('Invalid token');
    });

    it('should return 401 when token is expired', async () => {
      const res = await request(app)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${expiredToken}`)
        .send({});
      expect(res.status).toBe(401);
      expect(res.body.detail).toBe('Token has expired');
    });

    it('should return 201 when a valid token is provided', async () => {
      const res = await request(app)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${validToken}`)
        .send({ amount: 1000, customer: 'Test Corp' });
      expect(res.status).toBe(201);
      expect(res.body.data).toHaveProperty('id');
    });
  });

  // ─── Route Protection — GET /api/escrow/:invoiceId ───────────────────────

  describe('Route Protection — GET /api/escrow/:invoiceId', () => {
    it('should allow escrow read with valid token', async () => {
      const res = await request(app)
        .get('/api/escrow/test-invoice')
        .set('Authorization', `Bearer ${validToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.invoiceId).toBe('test-invoice');
    });

    it('should reject escrow read without token', async () => {
      const res = await request(app).get('/api/escrow/test-invoice');
      expect(res.status).toBe(401);
    });
  });

  // ─── Algorithm allowlist enforcement ─────────────────────────────────────

  describe('Algorithm allowlist enforcement', () => {
    it('should reject token signed with alg: none (crafted header)', async () => {
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({
        id: 1, role: 'user', exp: Math.floor(Date.now() / 1000) + 3600,
      })).toString('base64url');
      const noneToken = `${header}.${payload}.`;

      const res = await request(app)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${noneToken}`)
        .send({});
      expect(res.status).toBe(401);
      expect(res.body.detail).toBe('Invalid token');
    });

    it('should reject token signed with a disallowed algorithm (RS256)', async () => {
      const rsToken = jwt.sign(validPayload, privateKey, { algorithm: 'RS256' });
      const res = await request(app)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${rsToken}`)
        .send({});
      expect(res.status).toBe(401);
      expect(res.body.detail).toMatch(/algorithm not allowed/i);
    });
  });

  // ─── Issuer enforcement (only when JWT_ISSUER is set) ────────────────────

  const issuer = process.env.JWT_ISSUER;

  (issuer ? describe : describe.skip)('Issuer enforcement', () => {
    it('should accept token with correct issuer', async () => {
      const token = jwt.sign(validPayload, secret, { expiresIn: '1h', issuer });
      const res = await request(app)
        .get('/api/escrow/test-invoice')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it('should reject token with wrong issuer', async () => {
      const token = jwt.sign(validPayload, secret, { expiresIn: '1h', issuer: 'https://evil.com' });
      const res = await request(app)
        .get('/api/escrow/test-invoice')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
    });
  });

  // ─── Audience enforcement (only when JWT_AUDIENCE is set) ────────────────

  const audience = process.env.JWT_AUDIENCE;

  (audience ? describe : describe.skip)('Audience enforcement', () => {
    it('should accept token with correct audience', async () => {
      const token = jwt.sign(validPayload, secret, { expiresIn: '1h', audience });
      const res = await request(app)
        .get('/api/escrow/test-invoice')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it('should reject token with wrong audience', async () => {
      const token = jwt.sign(validPayload, secret, { expiresIn: '1h', audience: 'other-api' });
      const res = await request(app)
        .get('/api/escrow/test-invoice')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
    });
  });

  // ─── Malformed header edge cases ─────────────────────────────────────────

  describe('Malformed header edge cases', () => {
    it('should reject token with Basic scheme', async () => {
      const res = await request(app)
        .get('/api/escrow/test-invoice')
        .set('Authorization', 'Basic somecreds');
      expect(res.status).toBe(401);
    });

    it('should reject empty Authorization header', async () => {
      const res = await request(app)
        .get('/api/escrow/test-invoice')
        .set('Authorization', '');
      expect(res.status).toBe(401);
    });
  });
});
