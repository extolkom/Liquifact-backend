'use strict';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('../src/db/knex');

// Mock Knex (invest service uses DB-backed invoices, not in-memory lists)
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

const { createApp } = require('../src/index');

const TEST_SECRET = process.env.JWT_SECRET || 'test-secret';
const tenantA = 'tenant-a';
const validToken = jwt.sign({ id: 'user_investor', role: 'investor', tenantId: tenantA }, TEST_SECRET, { expiresIn: '1h' });

describe('Investment Opportunities API', () => {
  let app;
  let mockQuery;

  beforeAll(() => {
    app = createApp({ enableTestRoutes: true });
    mockQuery = db();
  });

  describe('GET /api/invest/opportunities', () => {
    it('should return 401 if no token is provided', async () => {
      const response = await request(app).get('/api/invest/opportunities');
      expect(response.status).toBe(401);
    });

    it('should return 200 with list of opportunities when authenticated', async () => {
      const response = await request(app)
        .get('/api/invest/opportunities')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBeGreaterThan(0);
      expect(response.body.message).toBe('Investment opportunities retrieved successfully.');
      expect(mockQuery.where).toHaveBeenCalledWith('tenant_id', tenantA);
    });

    it('should match the required JSON shape (DTO) aligned to Soroban reads', async () => {
      const response = await request(app)
        .get('/api/invest/opportunities')
        .set('Authorization', `Bearer ${validToken}`);

      const item = response.body.data[0];
      
      // Mandatory DTO fields per #135
      expect(item).toHaveProperty('invoiceId');
      expect(item).toHaveProperty('fundedBpsOfTarget');
      expect(item).toHaveProperty('maturityAt');
      expect(item).toHaveProperty('yieldBpsDisplay');
      expect(item).toHaveProperty('onChain');
      
      // On-chain pointers
      expect(item.onChain).toHaveProperty('escrowAddress');
      expect(item.onChain).toHaveProperty('ledgerIndex');
      
      // Type checks
      expect(typeof item.invoiceId).toBe('string');
      expect(typeof item.fundedBpsOfTarget).toBe('number');
      expect(typeof item.yieldBpsDisplay).toBe('number');
      expect(typeof item.onChain.escrowAddress).toBe('string');
    });

    it('should support pagination via page and limit query params', async () => {
      mockQuery.then.mockImplementationOnce(function (resolve) {
        return Promise.resolve([
          { id: 'inv_7788', funded_ratio: 25.0, maturity_date: '2026-06-15', yield_bps: 850 },
        ]).then(resolve);
      });

      const response = await request(app)
        .get('/api/invest/opportunities?page=1&limit=1')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBe(1);
      expect(response.body.meta).toMatchObject({
        page: 1,
        limit: 1,
        total: 3,
        totalPages: 3
      });
    });

    it('should handle edge-case pagination inputs gracefully', async () => {
      mockQuery.then.mockImplementationOnce(function (resolve) {
        return Promise.resolve([
          { id: 'inv_7788', funded_ratio: 25.0, maturity_date: '2026-06-15', yield_bps: 850 },
        ]).then(resolve);
      });

      const response = await request(app)
        .get('/api/invest/opportunities?page=invalid&limit=-50')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(200);
      // Fallback logic in service: page -> 1, limit -> 1 (min)
      expect(response.body.meta.page).toBe(1);
      expect(response.body.meta.limit).toBe(1);
    });
  });
});
