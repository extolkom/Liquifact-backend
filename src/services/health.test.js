/**
 * @file Tests for health check service.
 */

const {
  checkSorobanHealth,
  checkDatabaseHealth,
  inspectPoolHealth,
  performHealthChecks
} = require('./health');

describe('Health Service', () => {
  let originalEnv;
  let fetchMock;

  beforeEach(() => {
    originalEnv = { ...process.env };
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  describe('checkSorobanHealth', () => {
    it('should return unknown when SOROBAN_RPC_URL is not configured', async () => {
      delete process.env.SOROBAN_RPC_URL;

      const result = await checkSorobanHealth();

      expect(result.status).toBe('unknown');
      expect(result.error).toBe('SOROBAN_RPC_URL not configured');
    });

    it('should return healthy when Soroban RPC responds successfully', async () => {
      process.env.SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const result = await checkSorobanHealth();

      expect(result.status).toBe('healthy');
      expect(result.latency).toBeGreaterThanOrEqual(0);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://soroban-testnet.stellar.org',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        })
      );
    });

    it('should return unhealthy when Soroban RPC returns error status', async () => {
      process.env.SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
      fetchMock.mockResolvedValue({ ok: false, status: 503 });

      const result = await checkSorobanHealth();

      expect(result.status).toBe('unhealthy');
      expect(result.error).toBe('HTTP 503');
      expect(result.latency).toBeGreaterThanOrEqual(0);
    });

    it('should return unhealthy when Soroban RPC times out', async () => {
      process.env.SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      fetchMock.mockRejectedValue(abortError);

      const result = await checkSorobanHealth();

      expect(result.status).toBe('unhealthy');
      expect(result.error).toBe('The operation was aborted');
    });

    it('should classify latency as degraded when latency exceeds warn but not fail', async () => {
      process.env.SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
      // Warn at -1ms so any real latency (>= 0ms) exceeds warn; fail at 500ms
      process.env.SOROBAN_LATENCY_WARN_MS = '-1';
      process.env.SOROBAN_LATENCY_FAIL_MS = '500';

      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const result = await checkSorobanHealth();

      expect(result.status).toBe('degraded');
      expect(result.latency).toBeGreaterThanOrEqual(0);
    });

    it('should return unhealthy when network error occurs', async () => {
      process.env.SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
      fetchMock.mockRejectedValue(new Error('Network failure'));

      const result = await checkSorobanHealth();

      expect(result.status).toBe('unhealthy');
      expect(result.error).toBe('Network failure');
      expect(result.latency).toBeGreaterThanOrEqual(0);
    });
  });

  describe('checkDatabaseHealth', () => {
    it('should return not_configured when DATABASE_URL is not set', async () => {
      delete process.env.DATABASE_URL;

      const result = await checkDatabaseHealth();

      expect(result.status).toBe('not_configured');
    });

    it('should return healthy when DATABASE_URL is set and DB is reachable', async () => {
      process.env.DATABASE_URL = 'postgresql://localhost:5432/test';

      const result = await checkDatabaseHealth();

      expect(result.status).toBe('healthy');
      expect(result.latency).toBeGreaterThanOrEqual(0);
      expect(result.pool).toBeUndefined();
    });

    it('should return unhealthy when the DB query rejects', async () => {
      process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
      const db = require('../db/knex');
      db.raw.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const result = await checkDatabaseHealth();

      expect(result.status).toBe('unhealthy');
      expect(result.error).toBe('Database unreachable');
      expect(result.latency).toBeGreaterThanOrEqual(0);
    });

    it('should return unhealthy on acquisition timeout', async () => {
      process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
      process.env.DB_HEALTH_PROBE_TIMEOUT_MS = '10';
      const db = require('../db/knex');
      db.raw.mockImplementationOnce(
        () => new Promise(resolve => setTimeout(resolve, 500))
      );

      const result = await checkDatabaseHealth();

      expect(result.status).toBe('unhealthy');
      expect(result.error).toBe('Connection pool acquire timeout');
    });
  });

  describe('inspectPoolHealth', () => {
    it('returns null when knex instance has no client', () => {
      expect(inspectPoolHealth(null)).toBeNull();
      expect(inspectPoolHealth({})).toBeNull();
    });

    it('returns null when pool is absent', () => {
      expect(inspectPoolHealth({ client: {} })).toBeNull();
    });

    it('returns pool counters from tarn methods', () => {
      const fakeKnex = {
        client: {
          pool: {
            numUsed: () => 3,
            numFree: () => 7,
            numPendingAcquires: () => 1,
          },
          config: { pool: { max: 10 } },
        },
      };
      expect(inspectPoolHealth(fakeKnex)).toEqual({ used: 3, free: 7, pending: 1, max: 10 });
    });

    it('defaults max to 10 when config is absent', () => {
      const fakeKnex = {
        client: {
          pool: {
            numUsed: () => 0,
            numFree: () => 0,
            numPendingAcquires: () => 0,
          },
        },
      };
      const metrics = inspectPoolHealth(fakeKnex);
      expect(metrics.max).toBe(10);
    });
  });

  describe('performHealthChecks', () => {
    it('should return healthy when Soroban is healthy', async () => {
      process.env.SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const result = await performHealthChecks();

      expect(result.healthy).toBe(true);
      expect(result.checks.soroban.status).toBe('healthy');
      expect(result.checks.database.status).toBe('not_configured');
    });

    it('should return healthy when Soroban is not configured', async () => {
      delete process.env.SOROBAN_RPC_URL;

      const result = await performHealthChecks();

      expect(result.healthy).toBe(true);
      expect(result.checks.soroban.status).toBe('unknown');
    });

    it('should return unhealthy when Soroban is down', async () => {
      process.env.SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
      fetchMock.mockRejectedValue(new Error('Connection refused'));

      const result = await performHealthChecks();

      expect(result.healthy).toBe(false);
      expect(result.checks.soroban.status).toBe('unhealthy');
      expect(result.checks.soroban.error).toBe('Connection refused');
    });

    it('should check all dependencies in parallel', async () => {
      process.env.SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
      process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const start = Date.now();
      const result = await performHealthChecks();
      const duration = Date.now() - start;

      expect(result.checks.soroban).toBeDefined();
      expect(result.checks.database).toBeDefined();
      expect(duration).toBeLessThan(100);
    });
  });
});
