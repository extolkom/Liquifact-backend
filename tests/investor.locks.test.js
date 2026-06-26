'use strict';

const request = require('supertest');
const { createApp, resetStore } = require('../src/index');
const jwt = require('jsonwebtoken');
const investorCommitmentService = require('../src/services/investorCommitment');

const TEST_SECRET = process.env.JWT_SECRET || 'test-secret';
const validToken = jwt.sign({ id: 'user_investor', role: 'investor', tenantId: 'test-tenant' }, TEST_SECRET, { expiresIn: '1h' });

const ADDR1 = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOUJ3LNLRK';
const ADDR2 = 'GDGQVOKHW4VEJRU2TETD8G6RWJ3TVM3VROMV7I3ESNITIBLL6QL6RAIL';

describe('Investor Locks API', () => {
  let app;

  beforeAll(() => {
    resetStore();
    investorCommitmentService.clearInvestorLocks();
    investorCommitmentService.seedInvestorLocks();
    app = createApp({ enableTestRoutes: true });
  });

  afterAll(() => {
    investorCommitmentService.clearInvestorLocks();
  });

  describe('GET /api/investor/locks', () => {
    it('should return 401 if no token is provided', async () => {
      const response = await request(app).get('/api/investor/locks');
      expect(response.status).toBe(401);
    });

    it('should return 200 with all locks when authenticated without filters', async () => {
      const response = await request(app)
        .get('/api/investor/locks')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBeGreaterThan(0);
      expect(response.body.meta.stale).toBe(true);
    });

    it('should include pagination meta fields', async () => {
      const response = await request(app)
        .get('/api/investor/locks')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(200);
      expect(response.body.meta).toMatchObject({
        total: expect.any(Number),
        page: expect.any(Number),
        limit: expect.any(Number),
        totalPages: expect.any(Number),
        hasMore: expect.any(Boolean),
        stale: expect.any(Boolean),
      });
    });

    it('should return stale=true in meta when DB mirror data exists', async () => {
      const response = await request(app)
        .get('/api/investor/locks')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.body.meta.stale).toBe(true);
    });

    it('should filter by funderAddress when provided', async () => {
      const response = await request(app)
        .get(`/api/investor/locks?funderAddress=${ADDR1}`)
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBeGreaterThan(0);
      expect(response.body.data.every((l) => l.funderAddress === ADDR1)).toBe(true);
    });

    it('should return 400 for invalid address format', async () => {
      const response = await request(app)
        .get('/api/investor/locks?funderAddress=invalid')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('invalid Stellar address');
    });

    it('should filter by invoiceId when provided', async () => {
      const response = await request(app)
        .get('/api/investor/locks?invoiceId=inv_7788')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data.every((lock) => lock.invoiceId === 'inv_7788')).toBe(true);
    });

    // ── Pagination tests ──────────────────────────────────────────────────────

    it('should return the first page with limit=2', async () => {
      const response = await request(app)
        .get('/api/investor/locks?limit=2&page=1')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBe(2);
      expect(response.body.meta.page).toBe(1);
      expect(response.body.meta.limit).toBe(2);
      expect(response.body.meta.hasMore).toBe(true);
    });

    it('should return second page with limit=2', async () => {
      const response = await request(app)
        .get('/api/investor/locks?limit=2&page=2')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBe(2);
      expect(response.body.meta.page).toBe(2);
    });

    it('should return hasMore=false on last page', async () => {
      // 6 total locks seeded; last page at limit=4 is page 2 with 2 items
      const first = await request(app)
        .get('/api/investor/locks?limit=4&page=1')
        .set('Authorization', `Bearer ${validToken}`);
      const second = await request(app)
        .get('/api/investor/locks?limit=4&page=2')
        .set('Authorization', `Bearer ${validToken}`);

      expect(first.body.meta.hasMore).toBe(true);
      expect(second.body.meta.hasMore).toBe(false);
    });

    it('should return empty data array for a page beyond totalPages', async () => {
      const response = await request(app)
        .get('/api/investor/locks?limit=100&page=99')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([]);
      expect(response.body.meta.hasMore).toBe(false);
    });

    it('should return 400 for limit=0', async () => {
      const response = await request(app)
        .get('/api/investor/locks?limit=0')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('limit');
    });

    it('should return 400 for limit > 100', async () => {
      const response = await request(app)
        .get('/api/investor/locks?limit=101')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('limit');
    });

    it('should return 400 for non-integer limit', async () => {
      const response = await request(app)
        .get('/api/investor/locks?limit=abc')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('limit');
    });

    it('should return 400 for page=0', async () => {
      const response = await request(app)
        .get('/api/investor/locks?page=0')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('page');
    });

    it('should paginate funderAddress-scoped results', async () => {
      const response = await request(app)
        .get(`/api/investor/locks?funderAddress=${ADDR1}&limit=2&page=1`)
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBe(2);
      // All returned locks must belong to ADDR1 — no cross-funder leakage
      expect(response.body.data.every((l) => l.funderAddress === ADDR1)).toBe(true);
      expect(response.body.meta.hasMore).toBe(true);
    });

    it('should not leak ADDR2 locks when filtering by ADDR1', async () => {
      const response = await request(app)
        .get(`/api/investor/locks?funderAddress=${ADDR1}`)
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(200);
      const hasAddr2 = response.body.data.some((l) => l.funderAddress === ADDR2);
      expect(hasAddr2).toBe(false);
    });

    it('should return all pages consistently (no overlaps, no gaps)', async () => {
      const pageSize = 2;
      const seen = new Set();
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const res = await request(app)
          .get(`/api/investor/locks?limit=${pageSize}&page=${page}`)
          .set('Authorization', `Bearer ${validToken}`);

        expect(res.status).toBe(200);
        for (const lock of res.body.data) {
          const key = `${lock.invoiceId}:${lock.funderAddress}`;
          expect(seen.has(key)).toBe(false); // no duplicates
          seen.add(key);
        }
        hasMore = res.body.meta.hasMore;
        page++;
      }

      // All 6 seeded locks must have been seen
      expect(seen.size).toBe(6);
    });
  });

  describe('GET /api/investor/locks/:invoiceId', () => {
    it('should return 400 if funderAddress query param is missing', async () => {
      const response = await request(app)
        .get('/api/investor/locks/inv_7788')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('funderAddress');
    });

    it('should return 400 for invalid funderAddress', async () => {
      const response = await request(app)
        .get('/api/investor/locks/inv_7788?funderAddress=bad')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('invalid Stellar address');
    });

    it('should return 404 if lock not found', async () => {
      const response = await request(app)
        .get(`/api/investor/locks/nonexistent_invoice?funderAddress=${ADDR1}`)
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(404);
    });

    it('should return lock record when found', async () => {
      const response = await request(app)
        .get(`/api/investor/locks/inv_7788?funderAddress=${ADDR1}`)
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
      expect(response.body.data.funderAddress).toBe(ADDR1);
      expect(response.body.data.invoiceId).toBe('inv_7788');
      expect(response.body.data).toHaveProperty('claimNotBefore');
      expect(response.body.data).toHaveProperty('investorEffectiveYieldBps');
      expect(response.body.data).toHaveProperty('stale');
    });
  });
});

describe('Investor Commitment Service', () => {
  beforeEach(() => {
    investorCommitmentService.clearInvestorLocks();
  });

  describe('validateAddress', () => {
    it('should return valid for correct G... address', () => {
      const result = investorCommitmentService.validateAddress(ADDR1);
      expect(result.valid).toBe(true);
    });

    it('should return valid for correct C... address', () => {
      const result = investorCommitmentService.validateAddress(
        'CDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOUJ3LNLRK'
      );
      expect(result.valid).toBe(true);
    });

    it('should return invalid for empty string', () => {
      const result = investorCommitmentService.validateAddress('');
      expect(result.valid).toBe(false);
    });

    it('should return invalid for wrong prefix', () => {
      const result = investorCommitmentService.validateAddress('XDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25');
      expect(result.valid).toBe(false);
    });

    it('should return invalid for wrong length', () => {
      const result = investorCommitmentService.validateAddress('GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL');
      expect(result.valid).toBe(false);
    });
  });

  describe('setInvestorLock', () => {
    it('should create a new lock record', () => {
      const lock = investorCommitmentService.setInvestorLock({
        funderAddress: ADDR1,
        claimNotBefore: '2026-03-01T00:00:00Z',
        investorEffectiveYieldBps: 900,
        invoiceId: 'inv_test',
      });

      expect(lock.funderAddress).toBe(ADDR1);
      expect(lock.claimNotBefore).toBe('2026-03-01T00:00:00Z');
      expect(lock.investorEffectiveYieldBps).toBe(900);
      expect(lock.invoiceId).toBe('inv_test');
      expect(lock.stale).toBe(true);
    });

    it('should update existing lock', () => {
      investorCommitmentService.setInvestorLock({
        funderAddress: ADDR1,
        claimNotBefore: '2026-01-01T00:00:00Z',
        investorEffectiveYieldBps: 500,
        invoiceId: 'inv_upd',
      });

      investorCommitmentService.setInvestorLock({
        funderAddress: ADDR1,
        claimNotBefore: '2026-02-01T00:00:00Z',
        investorEffectiveYieldBps: 600,
        invoiceId: 'inv_upd',
      });

      const result = investorCommitmentService.getInvestorLocksByAddress(ADDR1, { invoiceId: 'inv_upd' });
      expect(result.data.length).toBe(1);
      expect(result.data[0].investorEffectiveYieldBps).toBe(600);
    });
  });

  describe('getInvestorLock', () => {
    it('should retrieve lock by invoiceId and funderAddress', () => {
      investorCommitmentService.setInvestorLock({
        funderAddress: ADDR2,
        claimNotBefore: '2026-04-01T00:00:00Z',
        investorEffectiveYieldBps: 750,
        invoiceId: 'inv_find',
      });

      const lock = investorCommitmentService.getInvestorLock('inv_find', ADDR2);
      expect(lock).toBeDefined();
      expect(lock.investorEffectiveYieldBps).toBe(750);
    });

    it('should return undefined for non-existent lock', () => {
      const lock = investorCommitmentService.getInvestorLock('inv_none', ADDR1);
      expect(lock).toBeUndefined();
    });
  });

  describe('getAllInvestorLocks pagination', () => {
    beforeEach(() => {
      // Seed 5 locks for ADDR1
      for (let i = 1; i <= 5; i++) {
        investorCommitmentService.setInvestorLock({
          funderAddress: ADDR1,
          claimNotBefore: `2026-0${i}-01T00:00:00Z`,
          investorEffectiveYieldBps: 500 + i * 10,
          invoiceId: `inv_p${i}`,
        });
      }
    });

    it('should return first page', () => {
      const result = investorCommitmentService.getAllInvestorLocks({ limit: 2, page: 1 });
      expect(result.data.length).toBe(2);
      expect(result.meta.page).toBe(1);
      expect(result.meta.total).toBe(5);
      expect(result.meta.hasMore).toBe(true);
      expect(result.meta.totalPages).toBe(3);
    });

    it('should return last page (partial)', () => {
      const result = investorCommitmentService.getAllInvestorLocks({ limit: 2, page: 3 });
      expect(result.data.length).toBe(1);
      expect(result.meta.hasMore).toBe(false);
    });

    it('should return empty data for out-of-range page', () => {
      const result = investorCommitmentService.getAllInvestorLocks({ limit: 10, page: 99 });
      expect(result.data).toEqual([]);
      expect(result.meta.hasMore).toBe(false);
    });

    it('should filter by invoiceId', () => {
      const result = investorCommitmentService.getAllInvestorLocks({ invoiceId: 'inv_p3' });
      expect(result.data.length).toBe(1);
      expect(result.data[0].invoiceId).toBe('inv_p3');
    });

    it('should clamp limit to 1..100', () => {
      const low = investorCommitmentService.getAllInvestorLocks({ limit: 0 });
      expect(low.meta.limit).toBe(1);

      const high = investorCommitmentService.getAllInvestorLocks({ limit: 999 });
      expect(high.meta.limit).toBe(100);
    });
  });

  describe('getInvestorLocksByAddress pagination', () => {
    beforeEach(() => {
      for (let i = 1; i <= 4; i++) {
        investorCommitmentService.setInvestorLock({
          funderAddress: ADDR1,
          claimNotBefore: `2026-0${i}-01T00:00:00Z`,
          investorEffectiveYieldBps: 500 + i * 10,
          invoiceId: `inv_a${i}`,
        });
      }
      // ADDR2 lock — must never appear in ADDR1 results
      investorCommitmentService.setInvestorLock({
        funderAddress: ADDR2,
        claimNotBefore: '2026-06-01T00:00:00Z',
        investorEffectiveYieldBps: 700,
        invoiceId: 'inv_b1',
      });
    });

    it('should only return locks for the specified funder', () => {
      const result = investorCommitmentService.getInvestorLocksByAddress(ADDR1);
      expect(result.data.every((l) => l.funderAddress === ADDR1)).toBe(true);
      expect(result.meta.total).toBe(4);
    });

    it('should paginate correctly for funderAddress scope', () => {
      const p1 = investorCommitmentService.getInvestorLocksByAddress(ADDR1, { limit: 2, page: 1 });
      const p2 = investorCommitmentService.getInvestorLocksByAddress(ADDR1, { limit: 2, page: 2 });

      expect(p1.data.length).toBe(2);
      expect(p1.meta.hasMore).toBe(true);
      expect(p2.data.length).toBe(2);
      expect(p2.meta.hasMore).toBe(false);
    });

    it('should not include ADDR2 locks when querying ADDR1', () => {
      const result = investorCommitmentService.getInvestorLocksByAddress(ADDR1);
      expect(result.data.some((l) => l.funderAddress === ADDR2)).toBe(false);
    });
  });
});
