'use strict';

const request = require('supertest');
const { batchReadEscrowStates } = require('../src/services/escrowBatchRead');
const jwt = require('jsonwebtoken');
const db = require('../src/db/knex');

// Mock Knex for DB-backed invest list
jest.mock('../src/db/knex', () => {
  const mockQuery = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    offset: jest.fn().mockReturnThis(),
    clone: jest.fn().mockReturnThis(),
    clearSelect: jest.fn().mockReturnThis(),
    clearOrder: jest.fn().mockReturnThis(),
    count: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue({ total: 3 }),
    then: jest.fn(function (resolve) {
      if (typeof resolve === 'function') {
        return Promise.resolve([
          { id: 'inv_7788', funded_ratio: 25.0, maturity_date: '2026-06-15', yield_bps: 850 },
          { id: 'inv_2244', funded_ratio: 95.0, maturity_date: '2026-05-20', yield_bps: 700 },
          { id: 'inv_9900', funded_ratio: 0.0, maturity_date: '2026-09-01', yield_bps: 1200 },
        ]).then(resolve);
      }
      return Promise.resolve([
        { id: 'inv_7788', funded_ratio: 25.0, maturity_date: '2026-06-15', yield_bps: 850 },
        { id: 'inv_2244', funded_ratio: 95.0, maturity_date: '2026-05-20', yield_bps: 700 },
        { id: 'inv_9900', funded_ratio: 0.0, maturity_date: '2026-09-01', yield_bps: 1200 },
      ]);
    }),
    catch: jest.fn().mockReturnThis(),
  };

  const mockDb = jest.fn(() => mockQuery);
  Object.assign(mockDb, mockQuery);
  return mockDb;
});

// Mock batch read
jest.mock('../src/services/escrowBatchRead', () => ({
  batchReadEscrowStates: jest.fn(),
}));

const { createApp } = require('../src/index');

const TEST_SECRET = process.env.JWT_SECRET || 'test-secret';
const tenantA = 'tenant-a';
const validToken = jwt.sign({ id: 'user_investor', role: 'investor', tenantId: tenantA }, TEST_SECRET, { expiresIn: '1h' });

describe('Invest Batched List API (/api/invest/list)', () => {
  let app;
  let mockQuery;

  beforeAll(() => {
    app = createApp({ enableTestRoutes: true });
    mockQuery = db();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return paginated opportunities with on-chain enrichment', async () => {
    batchReadEscrowStates.mockResolvedValue({
      results: [
        { invoiceId: 'inv_7788', status: 'active', fundedAmount: 5000, legal_hold: false },
        { invoiceId: 'inv_2244', status: 'pending', fundedAmount: 0, legal_hold: true },
      ],
      errors: [],
    });

    const res = await request(app)
      .get('/api/invest/list')
      .set('Authorization', `Bearer ${validToken}`)
      .query({ limit: 2 })
      .expect(200);

    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta.next_cursor).toBe('inv_2244');
    expect(res.body.meta.has_more).toBe(true);
    expect(mockQuery.where).toHaveBeenCalledWith('tenant_id', tenantA);
    
    // Check enrichment
    expect(res.body.data[0].onChain.status).toBe('active');
    expect(res.body.data[1].onChain.legal_hold).toBe(true);
  });

  it('should handle pagination via cursor', async () => {
    mockQuery.then.mockImplementationOnce(function (resolve) {
      return Promise.resolve([
        { id: 'inv_9900', funded_ratio: 0.0, maturity_date: '2026-09-01', yield_bps: 1200 },
      ]).then(resolve);
    });

    batchReadEscrowStates.mockResolvedValue({
      results: [
        { invoiceId: 'inv_9900', status: 'active', fundedAmount: 0, legal_hold: false },
      ],
      errors: [],
    });

    const res = await request(app)
      .get('/api/invest/list')
      .set('Authorization', `Bearer ${validToken}`)
      .query({ cursor: 'inv_2244', limit: 1 })
      .expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].invoiceId).toBe('inv_9900');
    expect(res.body.meta.next_cursor).toBe('inv_9900');
    expect(res.body.meta.has_more).toBe(true);
  });

  it('should include error messages when on-chain read fails for some items', async () => {
    batchReadEscrowStates.mockResolvedValue({
      results: [
        { invoiceId: 'inv_7788', status: 'active', fundedAmount: 5000, legal_hold: false },
      ],
      errors: [
        { invoiceId: 'inv_2244', error: 'RPC Timeout', code: 'ETIMEDOUT' },
      ],
    });

    const res = await request(app)
      .get('/api/invest/list')
      .set('Authorization', `Bearer ${validToken}`)
      .query({ limit: 2 })
      .expect(200);

    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[1].onChain.syncError).toBe('RPC Timeout');
  });
});
