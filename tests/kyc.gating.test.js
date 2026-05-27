'use strict';

/**
 * @file KYC config validation and /ready gating tests.
 *
 * Covers:
 *  1. Valid full config  — provider enabled, health check runs
 *  2. Partial config     — URL without key (and key without URL) rejected at boot
 *  3. Disabled (no envs) — provider skipped, /ready still healthy
 *  4. Degraded /ready    — provider unreachable → 503
 */

const { ConfigSchema } = require('../src/config/index');
const { checkKycHealth, performHealthChecks } = require('../src/services/health');

// ── helpers ──────────────────────────────────────────────────────────────────

/** Minimal valid env for ConfigSchema.parse() */
const BASE_ENV = {
  NODE_ENV: 'development',
  JWT_SECRET: 'a'.repeat(32),
};

// ── 1. Zod schema: valid full config ─────────────────────────────────────────

describe('ConfigSchema — KYC env vars', () => {
  it('accepts valid URL + key pair', () => {
    const result = ConfigSchema.safeParse({
      ...BASE_ENV,
      KYC_PROVIDER_URL: 'https://kyc.example.com',
      KYC_PROVIDER_API_KEY: 'secret-key',
    });
    expect(result.success).toBe(true);
    expect(result.data.KYC_PROVIDER_URL).toBe('https://kyc.example.com');
    expect(result.data.KYC_PROVIDER_API_KEY).toBe('secret-key');
  });

  it('accepts absent KYC vars (disabled)', () => {
    const result = ConfigSchema.safeParse({ ...BASE_ENV });
    expect(result.success).toBe(true);
    expect(result.data.KYC_PROVIDER_URL).toBeUndefined();
    expect(result.data.KYC_PROVIDER_API_KEY).toBeUndefined();
  });

  it('rejects URL without API key in non-test env', () => {
    const result = ConfigSchema.safeParse({
      ...BASE_ENV,
      KYC_PROVIDER_URL: 'https://kyc.example.com',
      // KYC_PROVIDER_API_KEY intentionally absent
    });
    expect(result.success).toBe(false);
    const paths = result.error.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('KYC_PROVIDER_API_KEY');
  });

  it('rejects API key without URL in non-test env', () => {
    const result = ConfigSchema.safeParse({
      ...BASE_ENV,
      KYC_PROVIDER_API_KEY: 'secret-key',
      // KYC_PROVIDER_URL intentionally absent
    });
    expect(result.success).toBe(false);
    const paths = result.error.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('KYC_PROVIDER_URL');
  });

  it('skips partial-config check in test env', () => {
    const result = ConfigSchema.safeParse({
      ...BASE_ENV,
      NODE_ENV: 'test',
      KYC_PROVIDER_URL: 'https://kyc.example.com',
      // KYC_PROVIDER_API_KEY absent — allowed in test
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-URL value for KYC_PROVIDER_URL', () => {
    const result = ConfigSchema.safeParse({
      ...BASE_ENV,
      KYC_PROVIDER_URL: 'not-a-url',
      KYC_PROVIDER_API_KEY: 'secret-key',
    });
    expect(result.success).toBe(false);
  });
});

// ── 2. checkKycHealth — disabled ─────────────────────────────────────────────

describe('checkKycHealth — disabled (no envs)', () => {
  beforeEach(() => {
    delete process.env.KYC_PROVIDER_URL;
    delete process.env.KYC_PROVIDER_API_KEY;
  });

  it('returns { status: "disabled" } when no KYC vars set', async () => {
    const result = await checkKycHealth();
    expect(result).toEqual({ status: 'disabled' });
  });
});

// ── 3. checkKycHealth — healthy provider ─────────────────────────────────────

describe('checkKycHealth — healthy provider', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.KYC_PROVIDER_URL = 'https://kyc.example.com';
    process.env.KYC_PROVIDER_API_KEY = 'test-api-key';
  });

  afterEach(() => {
    delete process.env.KYC_PROVIDER_URL;
    delete process.env.KYC_PROVIDER_API_KEY;
    global.fetch = originalFetch;
  });

  it('returns healthy when provider responds 200', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

    const result = await checkKycHealth();

    expect(result.status).toBe('healthy');
    expect(typeof result.latency).toBe('number');

    // API key must NOT appear in the response object
    expect(JSON.stringify(result)).not.toContain('test-api-key');
  });

  it('sends Authorization header with the API key', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

    await checkKycHealth();

    const [, options] = global.fetch.mock.calls[0];
    expect(options.headers.Authorization).toBe('Bearer test-api-key');
  });

  it('uses HEAD method (lightweight probe)', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

    await checkKycHealth();

    const [, options] = global.fetch.mock.calls[0];
    expect(options.method).toBe('HEAD');
  });

  it('returns healthy for 4xx (host reachable)', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401 });

    const result = await checkKycHealth();
    expect(result.status).toBe('healthy');
  });
});

// ── 4. checkKycHealth — degraded provider ────────────────────────────────────

describe('checkKycHealth — degraded provider', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.KYC_PROVIDER_URL = 'https://kyc.example.com';
    process.env.KYC_PROVIDER_API_KEY = 'test-api-key';
  });

  afterEach(() => {
    delete process.env.KYC_PROVIDER_URL;
    delete process.env.KYC_PROVIDER_API_KEY;
    global.fetch = originalFetch;
  });

  it('returns unhealthy when provider responds 5xx', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 });

    const result = await checkKycHealth();
    expect(result.status).toBe('unhealthy');
    expect(result.error).toMatch(/503/);
  });

  it('returns unhealthy when fetch throws (network error)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await checkKycHealth();
    expect(result.status).toBe('unhealthy');
    expect(result.error).toMatch(/ECONNREFUSED/);
  });
});

// ── 5. performHealthChecks — /ready degraded state ───────────────────────────

describe('performHealthChecks — /ready degraded when KYC unhealthy', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.KYC_PROVIDER_URL = 'https://kyc.example.com';
    process.env.KYC_PROVIDER_API_KEY = 'test-api-key';
    // Soroban URL must be set so it doesn't return 'unknown' (which counts as healthy)
    process.env.SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
  });

  afterEach(() => {
    delete process.env.KYC_PROVIDER_URL;
    delete process.env.KYC_PROVIDER_API_KEY;
    global.fetch = originalFetch;
  });

  it('healthy=false when KYC provider is unreachable', async () => {
    global.fetch = jest.fn().mockImplementation((url) => {
      if (url.includes('soroban')) {
        return Promise.resolve({ ok: true, status: 200 });
      }
      return Promise.reject(new Error('ECONNREFUSED'));
    });

    const { healthy, checks } = await performHealthChecks();
    expect(healthy).toBe(false);
    expect(checks.kyc.status).toBe('unhealthy');
  });

  it('healthy=true when KYC is disabled and soroban is healthy', async () => {
    delete process.env.KYC_PROVIDER_URL;
    delete process.env.KYC_PROVIDER_API_KEY;

    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

    const { healthy, checks } = await performHealthChecks();
    expect(healthy).toBe(true);
    expect(checks.kyc.status).toBe('disabled');
  });
});
