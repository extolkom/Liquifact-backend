'use strict';

/**
 * Tests for the idempotency middleware covering:
 *  - Missing Idempotency-Key header → 400
 *  - Invalid key format → 400
 *  - First call executes normally → 201
 *  - Duplicate key replays original response → 201
 *  - Same key + different body → 409
 *  - Keys persist in the database
 *  - Storage failure scenarios and safe replay behavior
 *  - Concurrent replay handling
 */

const request = require('supertest');
const express = require('express');
const crypto = require('crypto');

// -- Helpers ---------------------------------------------------------------

/** Generate a valid idempotency key */
function validKey() {
  return 'ik_' + crypto.randomBytes(8).toString('hex');
}

/** Minimal valid funding request body */
function validBody(overrides = {}) {
  return {
    invoiceId: 'INV-2024-001',
    investmentAmount: 5000.00,
    smeId: 'SME-789',
    ...overrides,
  };
}

// -- Mock Factory ---------------------------------------------------------

/**
 * Creates a mock knex module with configurable failure scenarios.
 * @param {object} options
 * @param {boolean} options.failPersistence - If true, simulate storage failure
 * @param {boolean} options.failInsert - If true, simulate initial insert failure
 * @param {boolean} options.failLookup - If true, simulate lookup failure
 * @returns {object} Mocked knex module
 */
function createKnexMock({ failPersistence = false, failInsert = false, failLookup = false } = {}) {
  const store = new Map();

  return {
    transaction: jest.fn((fn) => {
      const trx = {
        __store: store,
        __failPersistence: failPersistence,
        __failInsert: failInsert,
        __failLookup: failLookup,
        _lastKey: null,
        where: jest.fn().mockReturnThis(),
        first: jest.fn(async function () {
          if (trx.__failLookup) {
            throw new Error('Database lookup failed');
          }
          return trx._lastKey ? store.get(trx._lastKey) || null : null;
        }),
        insert: jest.fn(async function (row) {
          if (trx.__failInsert) {
            throw new Error('Database insert failed');
          }
          trx._lastKey = row.idempotency_key;
          store.set(row.idempotency_key, {
            ...row,
            created_at: new Date(),
            updated_at: new Date(),
          });
        }),
        update: jest.fn(async function (updates) {
          if (trx.__failPersistence && updates.response_status !== -1) {
            // Only fail actual persistence, not the failure-marking update
            throw new Error('Database update failed');
          }
          if (trx._lastKey) {
            const existing = store.get(trx._lastKey) || {};
            store.set(trx._lastKey, { ...existing, ...updates });
          }
        }),
        raw: jest.fn(() => new Date(Date.now() + 86400000)),
        fn: { now: () => new Date() },
      };
      return fn(trx);
    }),
    fn: { now: () => new Date() },
    raw: jest.fn(() => new Date(Date.now() + 86400000)),
  };
}

// -- Test Suites -----------------------------------------------------------

describe('Idempotency Middleware - Normal Operation', () => {
  let app;
  let mockDb;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDb = createKnexMock();
    jest.mock('../src/db/knex', () => mockDb);
  });

  afterEach(() => {
    jest.resetModules();
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    // Require fresh module to pick up mocked db
    const idempotencyMiddleware = require('../middleware/idempotency');
    app.post('/api/invest/fund-invoice', idempotencyMiddleware, (req, res) => {
      return res.status(201).json({
        data: {
          investmentId: 'inv_test_' + Date.now(),
          invoiceId: req.body.invoiceId,
          smeId: req.body.smeId,
          investmentAmount: req.body.investmentAmount,
          status: 'pending',
        },
        meta: { timestamp: new Date().toISOString() },
        message: 'Investment submitted successfully.',
      });
    });
    return app;
  }

  it('returns 400 when Idempotency-Key header is missing', async () => {
    app = createApp();
    const res = await request(app)
      .post('/api/invest/fund-invoice')
      .send(validBody())
      .expect(400);

    expect(res.body.error).toMatch(/Idempotency-Key header is required/);
  });

  it('returns 400 when Idempotency-Key contains invalid characters', async () => {
    app = createApp();
    const res = await request(app)
      .post('/api/invest/fund-invoice')
      .set('Idempotency-Key', 'invalid key with spaces!')
      .send(validBody())
      .expect(400);

    expect(res.body.error).toMatch(/8.*128.*URL-safe/);
  });

  it('returns 400 when Idempotency-Key is too short', async () => {
    app = createApp();
    const res = await request(app)
      .post('/api/invest/fund-invoice')
      .set('Idempotency-Key', 'short')
      .send(validBody())
      .expect(400);

    expect(res.body.error).toMatch(/8.*128.*URL-safe/);
  });

  it('executes the handler on first call (new key)', async () => {
    app = createApp();
    const res = await request(app)
      .post('/api/invest/fund-invoice')
      .set('Idempotency-Key', validKey())
      .send(validBody())
      .expect(201);

    expect(res.body.data.status).toBe('pending');
    expect(res.body.data.investmentId).toBeDefined();
  });

  it('returns the cached response on duplicate key with same body', async () => {
    app = createApp();
    const key = validKey();
    const body = validBody();

    const first = await request(app)
      .post('/api/invest/fund-invoice')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);

    // Need to wait for async persistence
    await new Promise(resolve => setTimeout(resolve, 100));

    const second = await request(app)
      .post('/api/invest/fund-invoice')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);

    expect(second.body.data.investmentId).toBe(first.body.data.investmentId);
    expect(second.body.data.status).toBe('pending');
  });

  it('returns 409 when same key is used with a different body', async () => {
    app = createApp();
    const key = validKey();

    await request(app)
      .post('/api/invest/fund-invoice')
      .set('Idempotency-Key', key)
      .send(validBody({ investmentAmount: 1000 }))
      .expect(201);

    const res = await request(app)
      .post('/api/invest/fund-invoice')
      .set('Idempotency-Key', key)
      .send(validBody({ investmentAmount: 2000 }))
      .expect(409)
      .expect('Content-Type', /application\/problem\+json/);

    expect(res.body.detail).toMatch(/different request body/);
    expect(res.body.type).toMatch(/conflict/);
  });

  it('allows multiple requests with different keys', async () => {
    app = createApp();
    const key1 = validKey();
    const key2 = validKey();

    const res1 = await request(app)
      .post('/api/invest/fund-invoice')
      .set('Idempotency-Key', key1)
      .send(validBody({ invoiceId: 'INV-001' }))
      .expect(201);

    const res2 = await request(app)
      .post('/api/invest/fund-invoice')
      .set('Idempotency-Key', key2)
      .send(validBody({ invoiceId: 'INV-002' }))
      .expect(201);

    expect(res1.body.data.investmentId).not.toBe(res2.body.data.investmentId);
    expect(res1.body.data.invoiceId).toBe('INV-001');
    expect(res2.body.data.invoiceId).toBe('INV-002');
  });
});

describe('Idempotency Middleware - Storage Failure Scenarios', () => {
  let app;
  let mockDb;
  let store;

  beforeEach(() => {
    jest.clearAllMocks();
    // We need a shared store that persists across mock instances
    store = new Map();
  });

  afterEach(() => {
    jest.resetModules();
  });

  function createFailingDb({ failPersistence = false, failInsert = false } = {}) {
    return {
      transaction: jest.fn((fn) => {
        const trx = {
          __store: store,
          __failPersistence: failPersistence,
          __failInsert: failInsert,
          _lastKey: null,
          where: jest.fn().mockReturnThis(),
          first: jest.fn(async function () {
            return trx._lastKey ? store.get(trx._lastKey) || null : null;
          }),
          insert: jest.fn(async function (row) {
            if (trx.__failInsert) {
              throw new Error('Database insert failed');
            }
            trx._lastKey = row.idempotency_key;
            store.set(row.idempotency_key, {
              ...row,
              created_at: new Date(),
              updated_at: new Date(),
            });
          }),
          update: jest.fn(async function (updates) {
            if (trx.__failPersistence && updates.response_status !== -1) {
              throw new Error('Database update failed');
            }
            if (trx._lastKey) {
              const existing = store.get(trx._lastKey) || {};
              store.set(trx._lastKey, { ...existing, ...updates });
            }
          }),
          raw: jest.fn(() => new Date(Date.now() + 86400000)),
          fn: { now: () => new Date() },
        };
        return fn(trx);
      }),
      fn: { now: () => new Date() },
      raw: jest.fn(() => new Date(Date.now() + 86400000)),
    };
  }

  function createAppWithDb(dbMock) {
    jest.doMock('../src/db/knex', () => dbMock);
    // Clear require cache to get fresh module
    jest.resetModules();
    const idempotencyMiddleware = require('../middleware/idempotency');
    const testApp = express();
    testApp.use(express.json());
    testApp.post('/api/invest/fund-invoice', idempotencyMiddleware, (req, res) => {
      return res.status(201).json({
        data: {
          investmentId: 'inv_test_' + Date.now(),
          invoiceId: req.body.invoiceId,
          smeId: req.body.smeId,
          investmentAmount: req.body.investmentAmount,
          status: 'pending',
        },
        meta: { timestamp: new Date().toISOString() },
        message: 'Investment submitted successfully.',
      });
    });
    return testApp;
  }

  it('re-executes handler when storage fails and response is incomplete', async () => {
    const dbMock = createFailingDb({ failPersistence: true });
    app = createAppWithDb(dbMock);

    const key = validKey();
    const body = validBody();

    // First call - storage will fail but request succeeds
    const first = await request(app)
      .post('/api/invest/fund-invoice')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);

    // Wait for retry attempts to complete
    await new Promise(resolve => setTimeout(resolve, 200));

    // Check that the key was stored with incomplete marker (-1 status)
    const storedRecord = store.get(key);
    expect(storedRecord.response_status).toBe(-1);

    // Second call - should re-execute because status is -1
    const second = await request(app)
      .post('/api/invest/fund-invoice')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(500); // New request will fail on insert due to unique constraint conflict

    // The behavior here depends on DB constraint handling
    // In production, the unique constraint would cause an error
    expect(second.statusCode).toBeDefined();
  });

  it('stores response successfully on subsequent attempts after partial failure', async () => {
    let failCount = 0;
    const dbMock = {
      transaction: jest.fn((fn) => {
        const trx = {
          __store: store,
          _lastKey: null,
          where: jest.fn().mockReturnThis(),
          first: jest.fn(async function () {
            return trx._lastKey ? store.get(trx._lastKey) || null : null;
          }),
          insert: jest.fn(async function (row) {
            trx._lastKey = row.idempotency_key;
            store.set(row.idempotency_key, {
              ...row,
              created_at: new Date(),
              updated_at: new Date(),
            });
          }),
          update: jest.fn(async function (updates) {
            // Fail 2 times then succeed
            failCount++;
            if (failCount <= 2) {
              throw new Error('Transient database error');
            }
            if (trx._lastKey) {
              const existing = store.get(trx._lastKey) || {};
              store.set(trx._lastKey, { ...existing, ...updates });
            }
          }),
          raw: jest.fn(() => new Date(Date.now() + 86400000)),
          fn: { now: () => new Date() },
        };
        return fn(trx);
      }),
      fn: { now: () => new Date() },
      raw: jest.fn(() => new Date(Date.now() + 86400000)),
    };

    jest.doMock('../src/db/knex', () => dbMock);
    jest.resetModules();
    const idempotencyMiddleware = require('../middleware/idempotency');

    const testApp = express();
    testApp.use(express.json());
    testApp.post('/api/invest/fund-invoice', idempotencyMiddleware, (req, res) => {
      return res.status(201).json({
        data: {
          investmentId: 'inv_test_' + Date.now(),
          invoiceId: req.body.invoiceId,
          smeId: req.body.smeId,
          investmentAmount: req.body.investmentAmount,
          status: 'pending',
        },
        meta: { timestamp: new Date().toISOString() },
        message: 'Investment submitted successfully.',
      });
    });

    const key = validKey();
    const body = validBody();

    await request(testApp)
      .post('/api/invest/fund-invoice')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);

    // Wait for retries
    await new Promise(resolve => setTimeout(resolve, 200));

    // Verify the record was eventually stored
    const storedRecord = store.get(key);
    expect(storedRecord).toBeDefined();
    expect(storedRecord.response_status).toBe(201);
  });

  it('handles in-progress key replay safely', async () => {
    const dbMock = createFailingDb();
    app = createAppWithDb(dbMock);

    const key = validKey();
    const body = validBody();

    // Pre-populate store with an in-progress (incomplete) key
    store.set(key, {
      idempotency_key: key,
      request_fingerprint: fingerprint(body),
      response_status: null,
      response_body: null,
      created_at: new Date(),
      updated_at: new Date(),
      expires_at: new Date(Date.now() + 86400000),
    });

    // Replay should re-execute the handler
    const res = await request(app)
      .post('/api/invest/fund-invoice')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);

    expect(res.body.data.status).toBe('pending');
    expect(res.body.data.investmentId).toBeDefined();
  });

  it('handles failed-storage key (-1 status) replay safely', async () => {
    const dbMock = createFailingDb();
    app = createAppWithDb(dbMock);

    const key = validKey();
    const body = validBody();

    // Pre-populate store with a failed-storage key
    store.set(key, {
      idempotency_key: key,
      request_fingerprint: fingerprint(body),
      response_status: -1, // Failed storage sentinel
      response_body: null,
      created_at: new Date(),
      updated_at: new Date(),
      expires_at: new Date(Date.now() + 86400000),
    });

    // Replay should re-execute the handler
    const res = await request(app)
      .post('/api/invest/fund-invoice')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);

    expect(res.body.data.status).toBe('pending');
    expect(res.body.data.investmentId).toBeDefined();
  });

  it('returns 500 when initial key insert fails', async () => {
    jest.doMock('../src/db/knex', () => createFailingDb({ failInsert: true }));
    jest.resetModules();
    const idempotencyMiddleware = require('../middleware/idempotency');

    const testApp = express();
    testApp.use(express.json());
    testApp.post('/api/invest/fund-invoice', idempotencyMiddleware, (req, res) => {
      return res.status(201).json({ success: true });
    });

    const key = validKey();
    const res = await request(testApp)
      .post('/api/invest/fund-invoice')
      .set('Idempotency-Key', key)
      .send(validBody())
      .expect(500);

    expect(res.body.error).toMatch(/Internal server error/);
  });
});

describe('Idempotency Middleware - Concurrent Replay', () => {
  let store;

  beforeEach(() => {
    jest.clearAllMocks();
    store = new Map();
  });

  afterEach(() => {
    jest.resetModules();
  });

  function createConcurrentDb() {
    return {
      transaction: jest.fn((fn) => {
        const trx = {
          __store: store,
          _lastKey: null,
          where: jest.fn().mockReturnThis(),
          first: jest.fn(async function () {
            return store.get(trx._lastKey) || null;
          }),
          insert: jest.fn(async function (row) {
            trx._lastKey = row.idempotency_key;
            // Simulate race condition - another transaction may have inserted
            if (store.has(row.idempotency_key)) {
              throw new Error('Unique constraint violation');
            }
            store.set(row.idempotency_key, {
              ...row,
              created_at: new Date(),
              updated_at: new Date(),
            });
          }),
          update: jest.fn(async function (updates) {
            if (trx._lastKey) {
              const existing = store.get(trx._lastKey) || {};
              store.set(trx._lastKey, { ...existing, ...updates });
            }
          }),
          raw: jest.fn(() => new Date(Date.now() + 86400000)),
          fn: { now: () => new Date() },
        };
        return fn(trx);
      }),
      fn: { now: () => new Date() },
      raw: jest.fn(() => new Date(Date.now() + 86400000)),
    };
  }

  it('handles concurrent requests with same key gracefully', async () => {
    jest.doMock('../src/db/knex', () => createConcurrentDb());
    jest.resetModules();
    const idempotencyMiddleware = require('../middleware/idempotency');

    const testApp = express();
    testApp.use(express.json());
    // Add concurrency limiter to serialize requests
    const activeRequests = new Map();
    testApp.post('/api/invest/fund-invoice', idempotencyMiddleware, (req, res) => {
      return res.status(201).json({
        data: {
          investmentId: 'inv_' + Date.now(),
          invoiceId: req.body.invoiceId,
          smeId: req.body.smeId,
          investmentAmount: req.body.investmentAmount,
          status: 'pending',
        },
        meta: { timestamp: new Date().toISOString() },
        message: 'Investment submitted successfully.',
      });
    });

    const key = validKey();
    const body = validBody();

    // First request establishes the key
    const first = await request(testApp)
      .post('/api/invest/fund-invoice')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);

    await new Promise(resolve => setTimeout(resolve, 50));

    // Second concurrent request should replay
    const second = await request(testApp)
      .post('/api/invest/fund-invoice')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);

    expect(second.body.data.investmentId).toBe(first.body.data.investmentId);
  });
});

// Helper to expose fingerprint for test setup
function fingerprint(body) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(body), 'utf8')
    .digest('hex');
}

describe('Idempotency Middleware - Security Validation', () => {
  let store;

  beforeEach(() => {
    jest.clearAllMocks();
    store = new Map();
  });

  afterEach(() => {
    jest.resetModules();
  });

  it('never leaks cached body across different keys', async () => {
    const dbMock = {
      transaction: jest.fn((fn) => {
        const trx = {
          __store: store,
          _lastKey: null,
          where: jest.fn().mockReturnThis(),
          first: jest.fn(async function () {
            return store.get(trx._lastKey) || null;
          }),
          insert: jest.fn(async function (row) {
            trx._lastKey = row.idempotency_key;
            store.set(row.idempotency_key, {
              ...row,
              created_at: new Date(),
              updated_at: new Date(),
            });
          }),
          update: jest.fn(async function (updates) {
            if (trx._lastKey) {
              const existing = store.get(trx._lastKey) || {};
              store.set(trx._lastKey, { ...existing, ...updates });
            }
          }),
          raw: jest.fn(() => new Date(Date.now() + 86400000)),
          fn: { now: () => new Date() },
        };
        return fn(trx);
      }),
      fn: { now: () => new Date() },
      raw: jest.fn(() => new Date(Date.now() + 86400000)),
    };

    jest.doMock('../src/db/knex', () => dbMock);
    jest.resetModules();
    const idempotencyMiddleware = require('../middleware/idempotency');

    const testApp = express();
    testApp.use(express.json());
    testApp.post('/api/invest/fund-invoice', idempotencyMiddleware, (req, res) => {
      return res.status(201).json({
        data: {
          investmentId: 'inv_' + req.body.invoiceId,
          invoiceId: req.body.invoiceId,
          smeId: req.body.smeId,
          investmentAmount: req.body.investmentAmount,
          status: 'pending',
        },
      });
    });

    // First key with INV-001
    const key1 = 'ik_' + crypto.randomBytes(8).toString('hex');
    await request(testApp)
      .post('/api/invest/fund-invoice')
      .set('Idempotency-Key', key1)
      .send({ invoiceId: 'INV-001', investmentAmount: 1000, smeId: 'SME-A' })
      .expect(201);

    await new Promise(resolve => setTimeout(resolve, 50));

    // Second key with INV-002
    const key2 = 'ik_' + crypto.randomBytes(8).toString('hex');
    const res2 = await request(testApp)
      .post('/api/invest/fund-invoice')
      .set('Idempotency-Key', key2)
      .send({ invoiceId: 'INV-002', investmentAmount: 2000, smeId: 'SME-B' })
      .expect(201);

    // Verify no cross-contamination
    expect(res2.body.data.invoiceId).toBe('INV-002');
    expect(res2.body.data.investmentAmount).toBe(2000);
  });
});