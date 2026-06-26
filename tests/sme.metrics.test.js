/**
 * Integration tests for the SME metrics endpoint.
 *
 * Bypasses the global knex mock to run tests against an in-memory SQLite database.
 */

'use strict';


jest.mock('../src/db/knex', () => {
  const knex = jest.requireActual('knex');
  const config = jest.requireActual('../knexfile')['test'];
  return knex(config);
});

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../src/index');
const db = require('../src/db/knex');

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long-string-for-jest';

describe('SME Metrics API', () => {
  const userId = 'test_sme_user';
  const tenantId = 'test_tenant';
  const token = jwt.sign({ id: userId, tenantId }, JWT_SECRET);

  beforeAll(async () => {
    // Run migration setup on SQLite
    await db.migrate.latest({ directory: './migrations' });
  });

  beforeEach(async () => {
    // Wipe invoices before each test
    await db('invoices').del();
  });

  afterAll(async () => {
    await db.destroy();
  });

  test('GET /api/sme/metrics - Returns correct counts for various statuses', async () => {
    await db('invoices').insert([
      { invoice_id: '1', sme_id: userId, tenant_id: tenantId, status: 'pending_verification', amount: 100, customer: 'Customer 1' },
      { invoice_id: '2', sme_id: userId, tenant_id: tenantId, status: 'verified', amount: 200, customer: 'Customer 2' },
      { invoice_id: '3', sme_id: userId, tenant_id: tenantId, status: 'funded', amount: 300, customer: 'Customer 3' },
      { invoice_id: '4', sme_id: userId, tenant_id: tenantId, status: 'settled', amount: 400, customer: 'Customer 4' },
      { invoice_id: '5', sme_id: userId, tenant_id: tenantId, status: 'paid', amount: 500, customer: 'Customer 5' },
      { invoice_id: '6', sme_id: userId, tenant_id: tenantId, status: 'defaulted', amount: 600, customer: 'Customer 6' }
    ]);

    const res = await request(app)
      .get('/api/sme/metrics')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      open: 2,      // pending_verification + verified
      funded: 1,    // funded
      settled: 2,   // settled + paid
      defaulted: 1  // defaulted
    });
    expect(res.body.timestamp).toBeDefined();
    expect(res.body.meta).toBeDefined();
    expect(res.body.meta.timestamp).toBeDefined();
  });

  test('GET /api/sme/metrics - Returns zeros for a new user with no invoices', async () => {
    const newUserToken = jwt.sign({ id: 'new_user', tenantId }, JWT_SECRET);

    const res = await request(app)
      .get('/api/sme/metrics')
      .set('Authorization', `Bearer ${newUserToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      open: 0,
      funded: 0,
      settled: 0,
      defaulted: 0
    });
  });

  test('GET /api/sme/metrics - Ensures "withdrawn" and other unmapped statuses are not counted', async () => {
    await db('invoices').insert([
      { invoice_id: '1', sme_id: userId, tenant_id: tenantId, status: 'withdrawn', amount: 100, customer: 'Customer 1' },
      { invoice_id: '2', sme_id: userId, tenant_id: tenantId, status: 'unknown_status', amount: 100, customer: 'Customer 2' },
      { invoice_id: '3', sme_id: userId, tenant_id: tenantId, status: 'pending_verification', amount: 100, customer: 'Customer 3' }
    ]);

    const res = await request(app)
      .get('/api/sme/metrics')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.open).toBe(1);
    const total = Object.values(res.body.data).reduce((a, b) => a + b, 0);
    expect(total).toBe(1);
  });

  test('GET /api/sme/metrics - Ignores soft-deleted invoices', async () => {
    await db('invoices').insert([
      { invoice_id: '1', sme_id: userId, tenant_id: tenantId, status: 'pending_verification', amount: 100, customer: 'Customer 1', deleted_at: new Date().toISOString() },
      { invoice_id: '2', sme_id: userId, tenant_id: tenantId, status: 'verified', amount: 200, customer: 'Customer 2' }
    ]);

    const res = await request(app)
      .get('/api/sme/metrics')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.open).toBe(1); // Only active verified invoice counted
    const total = Object.values(res.body.data).reduce((a, b) => a + b, 0);
    expect(total).toBe(1);
  });

  test('GET /api/sme/metrics - Enforces tenant isolation (Tenant A cannot see Tenant B)', async () => {
    const otherTenantId = 'other_tenant';
    await db('invoices').insert([
      { invoice_id: '1', sme_id: userId, tenant_id: tenantId, status: 'pending_verification', amount: 100, customer: 'Customer A' },
      { invoice_id: '2', sme_id: userId, tenant_id: otherTenantId, status: 'verified', amount: 200, customer: 'Customer B' }
    ]);

    const res = await request(app)
      .get('/api/sme/metrics')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.open).toBe(1); // Only Tenant A's invoice is counted
  });

  test('GET /api/sme/metrics - Enforces owner isolation (User A cannot see User B)', async () => {
    const otherUserId = 'other_sme_user';
    await db('invoices').insert([
      { invoice_id: '1', sme_id: userId, tenant_id: tenantId, status: 'pending_verification', amount: 100, customer: 'Customer A' },
      { invoice_id: '2', sme_id: otherUserId, tenant_id: tenantId, status: 'verified', amount: 200, customer: 'Customer B' }
    ]);

    const res = await request(app)
      .get('/api/sme/metrics')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.open).toBe(1); // Only User A's invoice is counted
  });

  test('GET /api/sme/metrics - Rejects unauthorized requests', async () => {
    const res = await request(app).get('/api/sme/metrics');
    expect(res.status).toBe(401);
  });

  test('GET /api/sme/metrics - Rejects request with missing tenant context (400)', async () => {
    const tokenNoTenant = jwt.sign({ id: userId }, JWT_SECRET);

    const res = await request(app)
      .get('/api/sme/metrics')
      .set('Authorization', `Bearer ${tokenNoTenant}`);

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Missing tenant context');
  });
});
