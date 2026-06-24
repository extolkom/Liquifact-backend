'use strict';

const request = require('supertest');
const jwt = require('jsonwebtoken');

// Mock native modules that cause GLIBC mismatch in this test environment
jest.mock('sqlite3', () => ({
  verbose: jest.fn(() => ({
    Database: jest.fn(() => ({
      run: jest.fn(),
      get: jest.fn(),
      close: jest.fn(),
    })),
  })),
}));

// Virtual mocks for modules with missing dependencies in this environment
jest.mock('@stellar/stellar-sdk', () => ({
  Keypair: { fromSecret: jest.fn(), random: jest.fn() },
}), { virtual: true });

jest.mock('@stellar/stellar-sdk/rpc', () => ({
  Server: jest.fn(),
}), { virtual: true });

jest.mock('../src/services/escrowSubmit', () => ({
  submitFundEscrow: jest.fn(),
  EscrowSubmitError: class EscrowSubmitError extends Error {},
}), { virtual: true });

jest.mock('../src/services/investorCommitment', () => ({
  persistCommitment: jest.fn(),
  updateCommitment: jest.fn(),
  findCommitments: jest.fn(),
}), { virtual: true });

jest.mock('../src/logger', () => ({
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../src/config/escrowMap', () => ({
  resolveEscrowAddress: jest.fn(() => 'CA3D5K7FJ3Z5Q6Q7W8E9R0T1Y2U3I4O5P6A7S8D9F0G1H2J3K4L5Z6X7C8V9B'),
  EscrowNotFoundError: class EscrowNotFoundError extends Error {},
}));

jest.mock('../src/services/escrowRead', () => ({
  readEscrowState: jest.fn(),
  readEscrowStateWithAttestations: jest.fn(),
  readFundedAmount: jest.fn(),
  fetchLegalHold: jest.fn(),
  fetchAttestationAppendLog: jest.fn(),
  validateInvoiceId: jest.fn(),
  getEscrowStateWithProjection: jest.fn(),
}));

jest.mock('../src/services/escrowBatchRead', () => ({
  batchReadEscrowStates: jest.fn(),
}));

const { batchReadEscrowStates } = require('../src/services/escrowBatchRead');

// -----------------------------------------------------------
// Singleton knex query chain — every db() call returns the
// SAME sharedQuery object so tests can assert on chain methods
// (where, whereIn, etc.) via the shared reference.
// -----------------------------------------------------------
let mockData = [];
let mockTotal = { total: 0 };

jest.mock('../src/db/knex', () => {
  const q = {
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
    first: jest.fn(() => Promise.resolve(mockTotal)),
    // Plain then function (not jest.fn) so await resolves correctly
    then(resolve, _reject) {
      return Promise.resolve(mockData).then(resolve);
    },
    catch: jest.fn().mockReturnThis(),
  };
  const knexMock = jest.fn(() => q);
  return knexMock;
});

const { createApp } = require('../src/app');

const TEST_SECRET = process.env.JWT_SECRET || 'test-secret';
const TENANT_A = 'tenant-alpha';

const INVOICES_DEFAULT = [
  { id: 'inv_001', funded_ratio: 25.0, maturity_date: '2026-06-15', yield_bps: 850 },
  { id: 'inv_002', funded_ratio: 95.0, maturity_date: '2026-05-20', yield_bps: 700 },
  { id: 'inv_003', funded_ratio: 0.0, maturity_date: '2026-09-01', yield_bps: 1200 },
];

// Grab the shared query singleton so tests can assert on chain methods
const db = require('../src/db/knex');
const sharedQuery = db();

describe('GET /api/invest/opportunities', () => {
  let app;
  let validToken;

  beforeAll(() => {
    app = createApp({ enableTestRoutes: true });
  });

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset shared state — the factory's first() and then() closures
    // reference these globals, so updating them controls every query.
    mockData = INVOICES_DEFAULT;
    mockTotal = { total: INVOICES_DEFAULT.length };

    // Default batch read success
    batchReadEscrowStates.mockResolvedValue({
      results: [
        { invoiceId: 'inv_001', status: 'active', fundedAmount: 25000, legal_hold: false, funding_token: null },
        { invoiceId: 'inv_002', status: 'active', fundedAmount: 95000, legal_hold: false, funding_token: null },
        { invoiceId: 'inv_003', status: 'pending', fundedAmount: 0, legal_hold: false, funding_token: null },
      ],
      errors: [],
    });

    validToken = jwt.sign(
      { id: 'user_investor', role: 'investor', tenantId: TENANT_A },
      TEST_SECRET,
      { expiresIn: '1h' },
    );
  });

  // ── a. Empty result set ─────────────────────────────────────────────────

  it('returns 200 with empty data when no investable invoices exist', async () => {
    mockData = [];
    mockTotal = { total: 0 };

    const res = await request(app)
      .get('/api/invest/opportunities')
      .set('Authorization', `Bearer ${validToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.total).toBe(0);
    expect(res.body.meta.page).toBe(1);
    expect(res.body.meta.limit).toBe(20);
    expect(res.body.meta.totalPages).toBe(0);
    expect(res.body.message).toBe('Investment opportunities retrieved successfully.');
  });

  // ── b. Single investable invoice ────────────────────────────────────────

  it('returns a single invoice with all required DTO fields', async () => {
    const singleInvoice = [
      { id: 'inv_single', funded_ratio: 50.0, maturity_date: '2026-12-31', yield_bps: 900 },
    ];
    mockData = singleInvoice;
    mockTotal = { total: 1 };

    batchReadEscrowStates.mockResolvedValue({
      results: [
        { invoiceId: 'inv_single', status: 'active', fundedAmount: 50000, legal_hold: false, funding_token: null },
      ],
      errors: [],
    });

    const res = await request(app)
      .get('/api/invest/opportunities')
      .set('Authorization', `Bearer ${validToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);

    const item = res.body.data[0];
    expect(item.invoiceId).toBe('inv_single');
    expect(item.fundedBpsOfTarget).toBe(5000);
    expect(item.maturityAt).toBe('2026-12-31T00:00:00.000Z');
    expect(item.yieldBpsDisplay).toBe(900);
    expect(item.onChain).toBeDefined();
    expect(item.onChain.escrowAddress).toBe('CA3D5K7FJ3Z5Q6Q7W8E9R0T1Y2U3I4O5P6A7S8D9F0G1H2J3K4L5Z6X7C8V9B');
    expect(item.onChain.status).toBe('active');
    expect(item.onChain.fundedAmount).toBe(50000);
    expect(item.onChain.legal_hold).toBe(false);
    expect(res.body.meta.total).toBe(1);
  });

  // ── c. Pagination ──────────────────────────────────────────────────────

  it('respects page and limit query parameters', async () => {
    mockData = [
      { id: 'inv_002', funded_ratio: 95.0, maturity_date: '2026-05-20', yield_bps: 700 },
    ];
    mockTotal = { total: 3 };

    batchReadEscrowStates.mockResolvedValue({
      results: [
        { invoiceId: 'inv_002', status: 'active', fundedAmount: 95000, legal_hold: false, funding_token: null },
      ],
      errors: [],
    });

    const res = await request(app)
      .get('/api/invest/opportunities?page=1&limit=1')
      .set('Authorization', `Bearer ${validToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].invoiceId).toBe('inv_002');
    expect(res.body.meta).toMatchObject({
      page: 1,
      limit: 1,
      total: 3,
      totalPages: 3,
    });
  });

  // ── d. Pagination bounds — page out of range ────────────────────────────

  it('returns empty data for page beyond available results', async () => {
    mockData = [];
    mockTotal = { total: 3 };

    const res = await request(app)
      .get('/api/invest/opportunities?page=999')
      .set('Authorization', `Bearer ${validToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.total).toBe(3);
    expect(res.body.meta.page).toBe(999);
  });

  // ── e. Non-investable statuses are never returned ───────────────────────

  it('filters by PUBLIC_INVESTABLE_INVOICE_STATUSES only', async () => {
    await request(app)
      .get('/api/invest/opportunities')
      .set('Authorization', `Bearer ${validToken}`);

    expect(sharedQuery.whereIn).toHaveBeenCalledWith('status', ['verified', 'partially_funded']);
  });

  // ── f. On-chain read failure skips enrichment for that invoice ──────────

  it('skips on-chain enrichment silently when batch read fails for one invoice', async () => {
    batchReadEscrowStates.mockResolvedValue({
      results: [
        { invoiceId: 'inv_001', status: 'active', fundedAmount: 25000, legal_hold: false },
      ],
      errors: [
        { invoiceId: 'inv_002', error: 'RPC Timeout', code: 'ETIMEDOUT' },
      ],
    });

    const res = await request(app)
      .get('/api/invest/opportunities')
      .set('Authorization', `Bearer ${validToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);

    expect(res.body.data[0].onChain.status).toBe('active');
    expect(res.body.data[1].invoiceId).toBe('inv_002');
    expect(res.body.data[1].onChain.escrowAddress).toBe('CA3D5K7FJ3Z5Q6Q7W8E9R0T1Y2U3I4O5P6A7S8D9F0G1H2J3K4L5Z6X7C8V9B');
  });

  // ── f2. Entire batch read fails — still return 200 ─────────────────────

  it('returns 200 with invoices (no on-chain data) when entire batch fails', async () => {
    batchReadEscrowStates.mockResolvedValue({
      results: [],
      errors: [
        { invoiceId: 'inv_001', error: 'Network error', code: 'ECONNREFUSED' },
        { invoiceId: 'inv_002', error: 'Network error', code: 'ECONNREFUSED' },
        { invoiceId: 'inv_003', error: 'Network error', code: 'ECONNREFUSED' },
      ],
    });

    const res = await request(app)
      .get('/api/invest/opportunities')
      .set('Authorization', `Bearer ${validToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.data[0].onChain.escrowAddress).toBe('CA3D5K7FJ3Z5Q6Q7W8E9R0T1Y2U3I4O5P6A7S8D9F0G1H2J3K4L5Z6X7C8V9B');
    expect(res.body.meta.total).toBe(3);
  });

  // ── g. Tenant scoping is enforced ───────────────────────────────────────

  it("queries only the authenticated tenant's invoices", async () => {
    await request(app)
      .get('/api/invest/opportunities')
      .set('Authorization', `Bearer ${validToken}`);

    expect(sharedQuery.where).toHaveBeenCalledWith('tenant_id', TENANT_A);
  });

  it('returns 401 when no auth token is provided', async () => {
    const res = await request(app).get('/api/invest/opportunities');
    expect(res.status).toBe(401);
  });

  it('returns 400 when JWT has no tenantId claim', async () => {
    const tokenNoTenant = jwt.sign({ sub: 'user_1', id: 'user_1' }, TEST_SECRET);
    const res = await request(app)
      .get('/api/invest/opportunities')
      .set('Authorization', `Bearer ${tokenNoTenant}`);
    expect(res.status).toBe(400);
  });

  // ── Edge-case pagination inputs ─────────────────────────────────────────

  it('handles invalid page and limit gracefully by using defaults', async () => {
    mockData = [
      { id: 'inv_001', funded_ratio: 25.0, maturity_date: '2026-06-15', yield_bps: 850 },
    ];
    mockTotal = { total: 3 };

    const res = await request(app)
      .get('/api/invest/opportunities?page=invalid&limit=-50')
      .set('Authorization', `Bearer ${validToken}`);

    expect(res.status).toBe(200);
    expect(res.body.meta.page).toBe(1);
    expect(res.body.meta.limit).toBe(1);
  });
});
