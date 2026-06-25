'use strict';

const request = require('supertest');
const { createStandardizedApp } = require('../src/app');
const db = require('../src/db/knex');
const { createRedisEscrowSummaryCache } = require('../src/cache/redis');

// Mock external dependencies
jest.mock('../src/config/escrowMap', () => ({
  resolveEscrowAddress: jest.fn((id) => {
    if (id === 'unknown-inv') return null;
    return `C_ESCROW_FOR_${id.toUpperCase()}`;
  }),
}));

// We'll mock soroban to test fallback
jest.mock('../src/services/soroban', () => ({
  callSorobanContract: jest.fn(async (operation) => {
    return operation();
  }),
}));

describe('GET /api/escrow/:invoiceId', () => {
  let app;
  let cache;

  beforeAll(() => {
    app = createStandardizedApp();
    cache = createRedisEscrowSummaryCache();
  });

  afterAll(async () => {
    await db.destroy();
    if (cache && cache.client) {
      await cache.client.quit();
    }
  });

  beforeEach(async () => {
    // Clear tables and cache
    await db('escrow_event_projection').del();
    if (cache && cache.client) {
      await cache.client.flushall();
    }
  });

  it('returns 404 for unknown invoice', async () => {
    const res = await request(app).get('/api/escrow/unknown-inv');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/No escrow contract mapping found/);
  });

  it('reads from projection table when cache misses', async () => {
    // Seed projection
    await db('escrow_event_projection').insert({
      invoice_id: 'inv-proj-1',
      latest_event_id: 'evt_1',
      latest_event_type: 'funded',
      latest_ledger_sequence: 12345,
      latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: 5000 }),
      latest_observed_at: new Date()
    });

    const res = await request(app).get('/api/escrow/inv-proj-1');
    expect(res.status).toBe(200);
    expect(res.headers['x-escrow-address']).toBe('C_ESCROW_FOR_INV-PROJ-1');
    expect(res.body.data.status).toBe('funded');
    expect(res.body.data.fundedAmount).toBe(5000);
    expect(res.body.data.latest_ledger_sequence).toBe(12345);
    expect(res.body.data.latest_event_type).toBe('funded');
    expect(res.body.message).toMatch(/from event projection/);

    // Verify it was cached
    if (cache) {
      const cacheResult = await cache.getSummary('inv-proj-1', 12346);
      expect(cacheResult.hit).toBe(true);
      expect(cacheResult.value.status).toBe('funded');
    }
  });

  it('falls back to live read if projection misses', async () => {
    const res = await request(app).get('/api/escrow/inv-live-1');
    expect(res.status).toBe(200);
    // No projection seeded: the fallback RPC stub must NOT fabricate funded
    // values. The neutral envelope reports status='not_found' regardless.
    expect(res.body.data.status).toBe('not_found');
    expect(res.body.data.fundedAmount).toBe(0);
    expect(res.body.message).toMatch(/live Soroban contract/);
  });

  it('does NOT fabricate funded/settled state from the legacy fixture names', async () => {
    // Issue #354 regression: legacy keys used to return hardcoded funded/settled
    // data. With the projection-first refactor, missing projection rows must
    // fall through to the neutral stub (status='not_found', fundedAmount=0)
    // rather than fabricate state the indexer has not yet recorded.
    await db('escrow_event_projection').del();

    const fundedRes = await request(app).get('/api/escrow/funded_invoice');
    expect(fundedRes.status).toBe(200);
    expect(fundedRes.body.data.status).toBe('not_found');
    expect(fundedRes.body.data.fundedAmount).toBe(0);
    expect(fundedRes.body.data.latest_event_type).toBe('live_read');
    expect(fundedRes.body.message).toMatch(/live Soroban contract/);

    const settledRes = await request(app).get('/api/escrow/settled_invoice');
    expect(settledRes.status).toBe(200);
    expect(settledRes.body.data.status).toBe('not_found');
    expect(settledRes.body.data.fundedAmount).toBe(0);
  });

  it('treats malformed projection JSON as missing data (no crash)', async () => {
    await db('escrow_event_projection').insert({
      invoice_id: 'inv-bad-json',
      latest_event_id: 'evt_bad',
      latest_event_type: 'funded',
      latest_ledger_sequence: 7,
      latest_event_body: '{not json',
      latest_observed_at: new Date(),
    });

    const res = await request(app).get('/api/escrow/inv-bad-json');
    expect(res.status).toBe(200);
    // Source still marked as projection (because a row exists) but funded
    // amount gracefully falls back to 0.
    expect(res.body.data.source).toBe('projection');
    expect(res.body.data.fundedAmount).toBe(0);
    expect(res.body.data.status).toBe('funded'); // falls back to event_type
  });

  it('serves projection as cache on second request', async () => {
    await db('escrow_event_projection').insert({
      invoice_id: 'inv-cache',
      latest_event_id: 'evt_c',
      latest_event_type: 'funded',
      latest_ledger_sequence: 50,
      latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: 100 }),
      latest_observed_at: new Date(),
    });

    const first = await request(app).get('/api/escrow/inv-cache');
    expect(first.status).toBe(200);
    expect(first.body.data.fundedAmount).toBe(100);

    // The first call should have populated the cache. Don't reseed projection.
    if (cache) {
      const cached = await cache.getSummary('inv-cache', 51);
      expect(cached.hit).toBe(true);
      expect(cached.value.fundedAmount).toBe(100);
    }
  });

  it('rejects an invalid invoiceId with INVALID_INVOICE_ID', async () => {
    // /api/escrow/:invoiceId rejects obviously bad ids upstream. We sanity
    // check here via the service helper since the route is gated by mapping.
    const { validateInvoiceId } = require('../src/services/escrowRead');
    expect(validateInvoiceId('').valid).toBe(false);
    expect(validateInvoiceId('   ').valid).toBe(false);
    expect(validateInvoiceId('bad id with spaces').valid).toBe(false);
  });

  it('invalidates cache on ledger gap', async () => {
    if (!cache) return; // Skip if no redis configured

    // Force set cache with old ledger
    await cache.setSummary('inv-gap-1', { status: 'pending', fundedAmount: 0 }, 1000);

    // If we were to query it at ledger 2000 (gap > threshold), it should miss.
    // In our app.js we don't pass currentLedger to cache.getSummary() so it doesn't gap-invalidate during GET.
    // But testing the cache gap invalidation directly:
    const cacheResult = await cache.getSummary('inv-gap-1', 2000);
    expect(cacheResult.hit).toBe(false);
    expect(cacheResult.reason).toBe('ledger_gap');
  });
});
