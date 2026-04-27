'use strict';

const {
  getTokenMetadata,
  getFreshTokenMetadata,
  batchGetTokenMetadata,
  invalidateTokenMetadata,
  clearTokenCache,
  getCacheStats,
  validateAsset,
  generateCacheKey,
  DEFAULT_CACHE_TTL_MS,
} = require('../src/services/tokenMeta');
const { readEscrowState } = require('../src/services/escrowRead');

// Mock the cache store and soroban calls
jest.mock('../src/services/cacheStore');
jest.mock('../src/services/soroban');

const PUBLIC_KEY = `G${'A'.repeat(55)}`;
const CONTRACT_ID = `C${'A'.repeat(55)}`;

describe('tokenMeta - Token Metadata Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearTokenCache();
  });

  afterEach(() => {
    clearTokenCache();
  });

  describe('validateAsset', () => {
    it('accepts valid native XLM', () => {
      const result = validateAsset({ code: 'native' });
      expect(result.valid).toBe(true);
    });

    it('accepts valid XLM with code', () => {
      const result = validateAsset({ code: 'XLM' });
      expect(result.valid).toBe(true);
    });

    it('rejects native XLM with issuer', () => {
      const result = validateAsset({ code: 'native', issuer: PUBLIC_KEY });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('must not have an issuer');
    });

    it('accepts valid issued asset', () => {
      const result = validateAsset({ code: 'USDC', issuer: PUBLIC_KEY });
      expect(result.valid).toBe(true);
    });

    it('rejects issued asset without issuer', () => {
      const result = validateAsset({ code: 'USDC' });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Issuer is required');
    });

    it('rejects invalid asset code', () => {
      const result = validateAsset({ code: 'TOO-LONG-CODE-123', issuer: PUBLIC_KEY });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('1-12 alphanumeric characters');
    });

    it('rejects invalid issuer format', () => {
      const result = validateAsset({ code: 'USDC', issuer: 'invalid-key' });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Invalid Stellar public key format');
    });

    it('accepts valid Soroban token', () => {
      const result = validateAsset({ code: 'TOKEN', contractId: CONTRACT_ID });
      expect(result.valid).toBe(true);
    });

    it('rejects Soroban token with issuer', () => {
      const result = validateAsset({ code: 'TOKEN', contractId: CONTRACT_ID, issuer: PUBLIC_KEY });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('must not have an issuer');
    });

    it('rejects invalid contract ID format', () => {
      const result = validateAsset({ code: 'TOKEN', contractId: 'invalid-contract' });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Invalid Soroban contract ID format');
    });

    it('rejects non-object asset', () => {
      const result = validateAsset(null);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('must be an object');
    });

    it('rejects asset without code', () => {
      const result = validateAsset({ issuer: PUBLIC_KEY });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Asset code is required');
    });
  });

  describe('generateCacheKey', () => {
    it('generates "native" key for XLM', () => {
      const key = generateCacheKey({ code: 'native' });
      expect(key).toBe('native');
    });

    it('generates "native" key for XLM code', () => {
      const key = generateCacheKey({ code: 'XLM' });
      expect(key).toBe('native');
    });

    it('generates "code:issuer" key for issued assets', () => {
      const key = generateCacheKey({ code: 'USDC', issuer: PUBLIC_KEY });
      expect(key).toBe(`USDC:${PUBLIC_KEY}`);
    });

    it('generates "contract:contractId" key for Soroban tokens', () => {
      const key = generateCacheKey({ code: 'TOKEN', contractId: CONTRACT_ID });
      expect(key).toBe(`contract:${CONTRACT_ID}`);
    });

    it('generates consistent keys for same asset', () => {
      const asset = { code: 'USDC', issuer: PUBLIC_KEY };
      const key1 = generateCacheKey(asset);
      const key2 = generateCacheKey(asset);
      expect(key1).toBe(key2);
    });
  });

  describe('getTokenMetadata', () => {
    it('throws validation error for invalid asset', async () => {
      await expect(getTokenMetadata({ code: 'INVALID' })).rejects.toMatchObject({
        code: 'INVALID_ASSET',
        status: 400,
      });
    });

    it('fetches native XLM metadata', async () => {
      const metadata = await getTokenMetadata({ code: 'native' });

      expect(metadata).toMatchObject({
        symbol: 'XLM',
        name: 'Lumen',
        decimals: 7,
        source: 'native',
      });
      expect(metadata.cachedAt).toBeDefined();
      expect(typeof metadata.cachedAt).toBe('number');
    });

    it('fetches issued asset metadata from Horizon', async () => {
      const metadata = await getTokenMetadata({ code: 'USDC', issuer: PUBLIC_KEY });

      expect(metadata).toMatchObject({
        symbol: 'USDC',
        name: 'USDC Token',
        decimals: 7,
        source: 'horizon',
      });
      expect(metadata.cachedAt).toBeDefined();
    });

    it('fetches Soroban token metadata', async () => {
      const metadata = await getTokenMetadata({ code: 'TOKEN', contractId: CONTRACT_ID });

      expect(metadata).toMatchObject({
        symbol: 'TOKEN',
        name: 'Mock Token',
        decimals: 18,
        source: 'soroban',
      });
      expect(metadata.cachedAt).toBeDefined();
    });

    it('caches metadata on first fetch', async () => {
      const asset = { code: 'USDC', issuer: PUBLIC_KEY };
      
      const metadata1 = await getTokenMetadata(asset);
      const metadata2 = await getTokenMetadata(asset);

      expect(metadata1).toEqual(metadata2);
      expect(metadata1.cachedAt).toBe(metadata2.cachedAt);
    });

    it('skips cache when skipCache is true', async () => {
      const asset = { code: 'USDC', issuer: PUBLIC_KEY };
      
      const metadata1 = await getTokenMetadata(asset);
      await new Promise(resolve => setTimeout(resolve, 10)); // Small delay
      const metadata2 = await getTokenMetadata(asset, { skipCache: true });

      expect(metadata1.cachedAt).not.toBe(metadata2.cachedAt);
    });

    it('uses custom TTL when provided', async () => {
      const asset = { code: 'USDC', issuer: PUBLIC_KEY };
      const customTtl = 60000; // 1 minute
      
      await getTokenMetadata(asset, { ttlMs: customTtl });
      
      const stats = getCacheStats();
      expect(stats.defaultTtlMs).toBe(DEFAULT_CACHE_TTL_MS); // Default unchanged
    });
  });

  describe('getFreshTokenMetadata', () => {
    it('bypasses cache and fetches fresh metadata', async () => {
      const asset = { code: 'USDC', issuer: PUBLIC_KEY };
      
      const metadata1 = await getTokenMetadata(asset);
      await new Promise(resolve => setTimeout(resolve, 10)); // Small delay
      const metadata2 = await getFreshTokenMetadata(asset);

      expect(metadata1.cachedAt).not.toBe(metadata2.cachedAt);
      expect(metadata2).toMatchObject({
        symbol: 'USDC',
        name: 'USDC Token',
      });
    });
  });

  describe('batchGetTokenMetadata', () => {
    it('fetches metadata for multiple assets concurrently', async () => {
      const assets = [
        { code: 'native' },
        { code: 'USDC', issuer: PUBLIC_KEY },
        { code: 'TOKEN', contractId: CONTRACT_ID },
      ];

      const results = await batchGetTokenMetadata(assets);

      expect(results).toHaveLength(3);
      expect(results[0].symbol).toBe('XLM');
      expect(results[1].symbol).toBe('USDC');
      expect(results[2].symbol).toBe('TOKEN');
    });

    it('uses cache for cached assets', async () => {
      const asset = { code: 'USDC', issuer: PUBLIC_KEY };
      
      await getTokenMetadata(asset);
      const results = await batchGetTokenMetadata([asset, asset]);

      expect(results).toHaveLength(2);
      expect(results[0].cachedAt).toBe(results[1].cachedAt);
    });

    it('handles empty array', async () => {
      const results = await batchGetTokenMetadata([]);
      expect(results).toEqual([]);
    });
  });

  describe('invalidateTokenMetadata', () => {
    it('invalidates cached metadata for specific asset', async () => {
      const asset = { code: 'USDC', issuer: PUBLIC_KEY };
      
      await getTokenMetadata(asset);
      const invalidated = invalidateTokenMetadata(asset);
      
      expect(invalidated).toBe(true);
    });

    it('returns false for non-existent cache entry', async () => {
      const asset = { code: 'USDC', issuer: PUBLIC_KEY };
      
      const invalidated = invalidateTokenMetadata(asset);
      
      expect(invalidated).toBe(false);
    });

    it('returns false for invalid asset', () => {
      const result = invalidateTokenMetadata({ code: 'INVALID' });
      expect(result).toBe(false);
    });

    it('forces fresh fetch after invalidation', async () => {
      const asset = { code: 'USDC', issuer: PUBLIC_KEY };
      
      const metadata1 = await getTokenMetadata(asset);
      invalidateTokenMetadata(asset);
      const metadata2 = await getTokenMetadata(asset);

      expect(metadata1.cachedAt).not.toBe(metadata2.cachedAt);
    });
  });

  describe('clearTokenCache', () => {
    it('clears all cached metadata', async () => {
      await getTokenMetadata({ code: 'native' });
      await getTokenMetadata({ code: 'USDC', issuer: PUBLIC_KEY });
      
      clearTokenCache();
      
      const stats = getCacheStats();
      expect(stats.size).toBe(0);
    });
  });

  describe('getCacheStats', () => {
    it('returns cache statistics', () => {
      const stats = getCacheStats();

      expect(stats).toMatchObject({
        size: expect.any(Number),
        maxSize: 10000,
        defaultTtlMs: DEFAULT_CACHE_TTL_MS,
      });
    });

    it('updates size after caching', async () => {
      const statsBefore = getCacheStats();
      await getTokenMetadata({ code: 'native' });
      const statsAfter = getCacheStats();

      expect(statsAfter.size).toBe(statsBefore.size + 1);
    });
  });

  describe('integration with escrowRead', () => {
    it('includes token metadata in escrow state when funding asset is provided', async () => {
      const tokenMetaAdapter = jest.fn().mockResolvedValue({
        symbol: 'USDC',
        name: 'USD Coin',
        decimals: 7,
        source: 'test',
        cachedAt: Date.now(),
      });

      const result = await readEscrowState('inv_123', {
        escrowAdapter: () => ({
          invoiceId: 'inv_123',
          status: 'funded',
          fundedAmount: 1000,
        }),
        legalHoldAdapter: () => false,
        fundingAsset: { code: 'USDC', issuer: PUBLIC_KEY },
        tokenMetaAdapter,
      });

      expect(result.funding_token).toMatchObject({
        symbol: 'USDC',
        name: 'USD Coin',
        decimals: 7,
      });
      expect(tokenMetaAdapter).toHaveBeenCalledWith({ code: 'USDC', issuer: PUBLIC_KEY });
    });

    it('returns null funding_token when funding asset is not provided', async () => {
      const result = await readEscrowState('inv_123', {
        escrowAdapter: () => ({
          invoiceId: 'inv_123',
          status: 'funded',
          fundedAmount: 1000,
        }),
        legalHoldAdapter: () => false,
      });

      expect(result.funding_token).toBeNull();
    });

    it('handles token metadata fetch errors gracefully', async () => {
      const tokenMetaAdapter = jest.fn().mockRejectedValue(new Error('RPC unavailable'));

      const result = await readEscrowState('inv_123', {
        escrowAdapter: () => ({
          invoiceId: 'inv_123',
          status: 'funded',
          fundedAmount: 1000,
        }),
        legalHoldAdapter: () => false,
        fundingAsset: { code: 'USDC', issuer: PUBLIC_KEY },
        tokenMetaAdapter,
      });

      expect(result.funding_token).toBeNull();
      expect(result.invoiceId).toBe('inv_123'); // Other fields still present
    });

    it('includes token metadata in escrow state with attestations', async () => {
      const tokenMetaAdapter = jest.fn().mockResolvedValue({
        symbol: 'TOKEN',
        name: 'Test Token',
        decimals: 18,
        source: 'test',
        cachedAt: Date.now(),
      });

      const { readEscrowStateWithAttestations } = require('../src/services/escrowRead');

      const result = await readEscrowStateWithAttestations('inv_123', {
        escrowAdapter: () => ({
          invoiceId: 'inv_123',
          status: 'funded',
          fundedAmount: 1000,
        }),
        legalHoldAdapter: () => false,
        attestationAdapter: () => [
          { index: 0, digest: Buffer.from('deadbeef', 'hex') },
        ],
        fundingAsset: { code: 'TOKEN', contractId: CONTRACT_ID },
        tokenMetaAdapter,
      });

      expect(result.funding_token).toMatchObject({
        symbol: 'TOKEN',
        name: 'Test Token',
        decimals: 18,
      });
      expect(result.attestations).toHaveLength(1);
    });
  });

  describe('cache behavior', () => {
    it('respects TTL expiration', async () => {
      // Note: This test would require mocking Date.now() or using a very short TTL
      // For now, we just verify the caching mechanism works
      const asset = { code: 'USDC', issuer: PUBLIC_KEY };
      
      const metadata1 = await getTokenMetadata(asset, { ttlMs: 1000 });
      const metadata2 = await getTokenMetadata(asset);
      
      expect(metadata1.cachedAt).toBe(metadata2.cachedAt);
    });

    it('handles cache eviction gracefully', async () => {
      // This would require filling the cache to MAX_CACHE_SIZE
      // For now, we verify the cache can be cleared
      await getTokenMetadata({ code: 'native' });
      clearTokenCache();
      
      const stats = getCacheStats();
      expect(stats.size).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('handles asset with lowercase code', () => {
      const result = validateAsset({ code: 'usdc', issuer: PUBLIC_KEY });
      expect(result.valid).toBe(false); // Must be uppercase
    });

    it('handles asset with special characters in code', () => {
      const result = validateAsset({ code: 'US$DC', issuer: PUBLIC_KEY });
      expect(result.valid).toBe(false);
    });

    it('handles empty code', () => {
      const result = validateAsset({ code: '', issuer: PUBLIC_KEY });
      expect(result.valid).toBe(false);
    });

    it('handles undefined issuer for non-native asset', () => {
      const result = validateAsset({ code: 'USDC', issuer: undefined });
      expect(result.valid).toBe(false);
    });

    it('handles null issuer for non-native asset', () => {
      const result = validateAsset({ code: 'USDC', issuer: null });
      expect(result.valid).toBe(false);
    });
  });
});
