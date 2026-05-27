'use strict';

const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../src/services/health', () => ({
  performHealthChecks: jest.fn(),
}));

jest.mock('../src/services/marketplaceService', () => ({
  getMarketplaceInvoices: jest.fn(),
}));

jest.mock('../src/config/escrowVersions', () => ({
  getOnChainSchemaVersion: jest.fn(),
  compareVersions: jest.fn(),
}));

jest.mock('../src/db/knex', () => {
  function createQuery(result) {
    const query = {
      where: jest.fn(() => query),
      whereNull: jest.fn(() => query),
      orderBy: jest.fn(() => query),
      select: jest.fn(() => query),
      insert: jest.fn(() => query),
      update: jest.fn(() => query),
      returning: jest.fn(() => Promise.resolve(result)),
      first: jest.fn(() => Promise.resolve(Array.isArray(result) ? result[0] || null : result)),
      then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
      catch: (reject) => Promise.resolve(result).catch(reject),
    };
    return query;
  }

  return jest.fn(() => createQuery([]));
});

const { performHealthChecks } = require('../src/services/health');
const marketplaceService = require('../src/services/marketplaceService');
const escrowVersions = require('../src/config/escrowVersions');
const app = require('../src/app');

function authHeader(payload = {}) {
  const token = jwt.sign(
    {
      sub: 'user_1',
      id: 'user_1',
      tenantId: 'tenant_test',
      ...payload,
    },
    process.env.JWT_SECRET || 'test-secret'
  );

  return `Bearer ${token}`;
}

describe('Mounted feature routers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    performHealthChecks.mockResolvedValue({
      healthy: true,
      checks: {
        database: { healthy: true },
        soroban: { healthy: true },
      },
    });
    marketplaceService.getMarketplaceInvoices.mockResolvedValue({
      data: [],
      meta: { total: 0, page: 1, limit: 10, totalPages: 0 },
    });
    escrowVersions.getOnChainSchemaVersion.mockResolvedValue(3);
    escrowVersions.compareVersions.mockReturnValue({
      status: 'current',
      knownVersion: '1.2.0',
    });
  });

  it('preserves existing health behavior', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ok');
    expect(res.body.data.service).toBe('liquifact-api');
  });

  it('preserves existing ready behavior', async () => {
    const res = await request(app).get('/ready');

    expect(res.status).toBe(200);
    expect(res.body.data.ready).toBe(true);
    expect(performHealthChecks).toHaveBeenCalledTimes(1);
  });

  it('preserves existing metrics auth behavior', async () => {
    const res = await request(app).get('/metrics');

    expect(res.status).not.toBe(404);
  });

  it('mounts invest routes under /api/invest', async () => {
    const res = await request(app)
      .get('/api/invest/opportunities')
      .set('Authorization', authHeader());

    expect(res.status).not.toBe(404);
  });

  it('mounts marketplace routes under /api/marketplace', async () => {
    const res = await request(app)
      .get('/api/marketplace')
      .set('Authorization', authHeader());

    expect(res.status).not.toBe(404);
    expect(marketplaceService.getMarketplaceInvoices).toHaveBeenCalledTimes(1);
  });

  it('mounts retention routes under /api/retention', async () => {
    const res = await request(app)
      .get('/api/retention/policies')
      .set('Authorization', authHeader())
      .set('x-tenant-id', 'tenant_test');

    expect(res.status).not.toBe(404);
  });

  it('mounts invoice state routes under /api/invoices', async () => {
    const res = await request(app).get('/api/invoices/inv-001/state');

    expect(res.status).not.toBe(404);
  });

  it('mounts admin escrow routes under /api/admin/escrow', async () => {
    const res = await request(app)
      .get('/api/admin/escrow/version')
      .set('Authorization', authHeader());

    expect(res.status).not.toBe(404);
    expect(escrowVersions.getOnChainSchemaVersion).toHaveBeenCalledTimes(1);
  });

  it('mounts sme routes under /api/sme', async () => {
    const res = await request(app)
      .get('/api/sme/metrics')
      .set('Authorization', authHeader());

    expect(res.status).not.toBe(404);
  });

  it('mounts v1 routes under /v1', async () => {
    const res = await request(app).get('/v1/health');

    expect(res.status).not.toBe(404);
  });
});
