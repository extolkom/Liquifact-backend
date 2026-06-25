/**
 * @fileoverview Attestation append log escrow tests.
 *
 * Covers:
 *  - fetchAttestationAppendLog returns array of {index, digest} with hex digests
 *  - readEscrowStateWithAttestations includes attestations in response
 *  - error handling: non-array response, RPC failures
 *  - input validation for invoiceId
 *
 * All on-chain calls are stubbed via adapter injection.
 */

'use strict';

process.env.NODE_ENV = 'test';

// Mock the logger to avoid dependency issues
jest.mock('../src/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));

// Stub the Knex default export with an in-memory store so we can drive the
// projection-first path without a real database. Only the
// `db('escrow_event_projection').where('invoice_id', id).first()` chain is
// exercised here; Knex's full surface is not required.
const projectionRows = new Map();
function makeProjectionBuilder() {
  const builder = {
    _table: 'escrow_event_projection',
    async first() {
      return projectionRows.get(builder._whereId) || null;
    },
    where(fieldOrObj, value) {
      builder._whereId = typeof fieldOrObj === 'string' ? String(value) : '';
      return builder;
    },
  };
  return builder;
}
const mockKnex = jest.fn((table) => {
  if (table === 'escrow_event_projection') {
    return makeProjectionBuilder();
  }
  // Other tables aren't exercised by the attestation read path; return a
  // safe empty shape that resolves to null instead of throwing so the rest
  // of the helper invocations stay quiet.
  return {
    _table: table,
    where() { return this; },
    async first() { return null; },
  };
});
jest.mock('../src/db/knex', () => mockKnex);

const { readEscrowStateWithAttestations, fetchAttestationAppendLog, validateInvoiceId } = require('../src/services/escrowRead');

// ── unit: escrowRead attestation service ──────────────────────────────────────

describe('escrowRead attestation service', () => {
  beforeEach(() => {
    projectionRows.clear();
    mockKnex.mockClear();
  });
  describe('fetchAttestationAppendLog', () => {
    it('returns array of attestation entries with hex digests', async () => {
      const mockAdapter = jest.fn().mockResolvedValue([
        { index: 0, digest: Buffer.from('deadbeef', 'hex') },
        { index: 1, digest: Buffer.from('cafebabe', 'hex') },
      ]);

      const result = await fetchAttestationAppendLog('inv_123', mockAdapter);

      expect(result).toEqual([
        { index: 0, digest: 'deadbeef' },
        { index: 1, digest: 'cafebabe' },
      ]);
      expect(mockAdapter).toHaveBeenCalledWith('inv_123');
    });

    it('handles empty array response', async () => {
      const mockAdapter = jest.fn().mockResolvedValue([]);

      const result = await fetchAttestationAppendLog('inv_123', mockAdapter);

      expect(result).toEqual([]);
    });

    it('handles non-array response by returning empty array', async () => {
      const mockAdapter = jest.fn().mockResolvedValue(null);

      const result = await fetchAttestationAppendLog('inv_123', mockAdapter);

      expect(result).toEqual([]);
    });

    it('handles RPC failure by returning empty array', async () => {
      const mockAdapter = jest.fn().mockRejectedValue(new Error('RPC error'));

      const result = await fetchAttestationAppendLog('inv_123', mockAdapter);

      expect(result).toEqual([]);
    });

    it('converts digest to hex string', async () => {
      const mockAdapter = jest.fn().mockResolvedValue([
        { index: 0, digest: Buffer.from('0123456789abcdef', 'hex') },
      ]);

      const result = await fetchAttestationAppendLog('inv_123', mockAdapter);

      expect(result[0].digest).toBe('0123456789abcdef');
    });

    it('handles missing digest gracefully', async () => {
      const mockAdapter = jest.fn().mockResolvedValue([
        { index: 0, digest: null },
      ]);

      const result = await fetchAttestationAppendLog('inv_123', mockAdapter);

      expect(result[0].digest).toBe('');
    });
  });

  describe('readEscrowStateWithAttestations', () => {
    it('includes attestations in escrow state response', async () => {
      const mockEscrowAdapter = jest.fn().mockResolvedValue({
        invoiceId: 'inv_123',
        status: 'funded',
        fundedAmount: 1000,
      });
      const mockLegalHoldAdapter = jest.fn().mockResolvedValue(false);
      const mockAttestationAdapter = jest.fn().mockResolvedValue([
        { index: 0, digest: 'hexdigest1' },
        { index: 1, digest: 'hexdigest2' },
      ]);

      const result = await readEscrowStateWithAttestations('inv_123', {
        escrowAdapter: mockEscrowAdapter,
        legalHoldAdapter: mockLegalHoldAdapter,
        attestationAdapter: mockAttestationAdapter,
      });

      expect(result).toEqual({
        invoiceId: 'inv_123',
        status: 'funded',
        fundedAmount: 1000,
        legal_hold: false,
        attestations: [
          { index: 0, digest: 'hexdigest1' },
          { index: 1, digest: 'hexdigest2' },
        ],
      });
    });

    it('validates invoiceId', async () => {
      await expect(readEscrowStateWithAttestations('')).rejects.toThrow('invoiceId must be a non-empty string');
      await expect(readEscrowStateWithAttestations('invalid@id')).rejects.toThrow('invoiceId contains invalid characters');
    });

    it('handles attestation adapter failure gracefully', async () => {
      const mockEscrowAdapter = jest.fn().mockResolvedValue({
        invoiceId: 'inv_123',
        status: 'funded',
        fundedAmount: 1000,
      });
      const mockLegalHoldAdapter = jest.fn().mockResolvedValue(false);
      const mockAttestationAdapter = jest.fn().mockRejectedValue(new Error('RPC error'));

      const result = await readEscrowStateWithAttestations('inv_123', {
        escrowAdapter: mockEscrowAdapter,
        legalHoldAdapter: mockLegalHoldAdapter,
        attestationAdapter: mockAttestationAdapter,
      });

      expect(result.attestations).toEqual([]);
    });

    it('reads base state from the projection when no adapter is injected', async () => {
      projectionRows.set('inv_proj_att', {
        invoice_id: 'inv_proj_att',
        latest_event_id: 'evt_p',
        latest_event_type: 'funded',
        latest_ledger_sequence: '42',
        latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: 2500 }),
      });

      const result = await readEscrowStateWithAttestations('inv_proj_att', {
        attestationAdapter: () => Promise.resolve([]),
      });

      expect(result).toMatchObject({
        invoiceId: 'inv_proj_att',
        status: 'funded',
        fundedAmount: 2500,
        attestations: [],
        source: 'projection',
        fromProjection: true,
      });
      expect(result.latest_ledger_sequence).toBe(42);
    });

    it('falls through to the neutral RPC stub when projection is missing', async () => {
      projectionRows.clear(); // safety
      const result = await readEscrowStateWithAttestations('inv_unknown', {
        attestationAdapter: () => Promise.resolve([]),
      });

      expect(result).toMatchObject({
        invoiceId: 'inv_unknown',
        status: 'not_found',
        fundedAmount: 0,
      });
      // The neutral stub must NOT fabricate funded/settled values.
      expect(result.fundedAmount).toBe(0);
    });
  });

  describe('validateInvoiceId', () => {
  });

  describe('validateInvoiceId', () => {
    it('accepts valid IDs', () => {
      expect(validateInvoiceId('inv_123').valid).toBe(true);
      expect(validateInvoiceId('INV-ABC-001').valid).toBe(true);
    });

    it('rejects invalid IDs', () => {
      expect(validateInvoiceId('').valid).toBe(false);
      expect(validateInvoiceId('invalid@id').valid).toBe(false);
    });
  });
});