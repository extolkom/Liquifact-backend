'use strict';

const request = require('supertest');
const { createApp } = require('../src/index');
const jwt = require('jsonwebtoken');
const db = require('../src/db/knex');

// Mock Knex
jest.mock('../src/db/knex', () => {
  const mockQuery = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    offset: jest.fn().mockReturnThis(),
    clone: jest.fn().mockReturnThis(),
    clearSelect: jest.fn().mockReturnThis(),
    clearOrder: jest.fn().mockReturnThis(),
    count: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue({ total: 1 }),
    then: jest.fn(function(resolve) {
      if (typeof resolve === 'function') {
        return Promise.resolve([{ id: 'inv_1', yield_bps: 500, funded_ratio: 50.0, maturity_date: '2024-12-31' }]).then(resolve);
      }
      return Promise.resolve([{ id: 'inv_1', yield_bps: 500, funded_ratio: 50.0, maturity_date: '2024-12-31' }]);
    }),
    catch: jest.fn().mockReturnThis(),
  };

  const mockDb = jest.fn(() => mockQuery);
  Object.assign(mockDb, mockQuery); // Also allow db.select() if used that way
  return mockDb;
});

const TEST_SECRET = process.env.JWT_SECRET || 'test-secret';
const validToken = jwt.sign({ id: 'user_investor', role: 'investor' }, TEST_SECRET, { expiresIn: '1h' });

describe('Marketplace API', () => {
  let app;
  let mockQuery;

  beforeAll(() => {
    app = createApp({ enableTestRoutes: true });
    mockQuery = db();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Default mock behavior for successful responses
    mockQuery.first.mockResolvedValue({ total: 1 });
    mockQuery.then.mockImplementation(function(resolve) {
      return Promise.resolve([{ id: 'inv_1', yield_bps: 500, funded_ratio: 50.0, maturity_date: '2024-12-31' }]).then(resolve);
    });
  });

  describe('GET /api/marketplace', () => {
    it('should return 401 if no token is provided', async () => {
      const response = await request(app).get('/api/marketplace');
      expect(response.status).toBe(401);
    });

    it('should return 200 with marketplace invoices when authenticated', async () => {
      const response = await request(app)
        .get('/api/marketplace')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.meta.total).toBe(1);
      expect(response.body.message).toBe('Marketplace invoices retrieved successfully.');
    });

    it('should apply filters correctly', async () => {
      const response = await request(app)
        .get('/api/marketplace?yieldBpsMin=400&yieldBpsMax=600&fundedRatioMin=20&fundedRatioMax=80&maturityDateFrom=2024-01-01&maturityDateTo=2024-12-31&status=verified')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(200);
      
      expect(mockQuery.where).toHaveBeenCalledWith('yield_bps', '>=', 400);
      expect(mockQuery.where).toHaveBeenCalledWith('yield_bps', '<=', 600);
      expect(mockQuery.where).toHaveBeenCalledWith('funded_ratio', '>=', 20);
      expect(mockQuery.where).toHaveBeenCalledWith('funded_ratio', '<=', 80);
      expect(mockQuery.where).toHaveBeenCalledWith('maturity_date', '>=', '2024-01-01');
      expect(mockQuery.where).toHaveBeenCalledWith('maturity_date', '<=', '2024-12-31');
      expect(mockQuery.where).toHaveBeenCalledWith('status', 'verified');
    });

    it('should apply sorting correctly', async () => {
      const response = await request(app)
        .get('/api/marketplace?sortBy=yield_bps&order=asc')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(200);
      expect(mockQuery.orderBy).toHaveBeenCalledWith('yield_bps', 'asc');
    });

    it('should handle pagination correctly', async () => {
      const response = await request(app)
        .get('/api/marketplace?page=2&limit=5')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(200);
      expect(mockQuery.limit).toHaveBeenCalledWith(5);
      expect(mockQuery.offset).toHaveBeenCalledWith(5);
      expect(response.body.meta.page).toBe(2);
      expect(response.body.meta.limit).toBe(5);
    });

    it('should return 400 for invalid query parameters', async () => {
      const response = await request(app)
        .get('/api/marketplace?yieldBpsMin=-100&fundedRatioMin=150&maturityDateFrom=invalid')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(400);
      expect(response.body.errors).toBeDefined();
      expect(response.body.errors.length).toBeGreaterThan(0);
    });

    it('should handle database errors gracefully', async () => {
      // Force an error in the service
      mockQuery.then.mockImplementationOnce((resolve, reject) => {
        if (typeof reject === 'function') {
          return reject(new Error('DB connection failed'));
        }
        throw new Error('DB connection failed');
      });

      const response = await request(app)
        .get('/api/marketplace')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(500);
      expect(response.body.error).toBeDefined();
    });
  });
});
