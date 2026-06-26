'use strict';

/**
 * KYC Service Persistence Tests
 * 
 * Verifies that KYC statuses are correctly saved to and retrieved from the database,
 * ensuring they survive service restarts and are idempotent.
 */

const knex = jest.requireActual('knex');
const knexConfig = require('../knexfile').test;
const realDb = knex(knexConfig);

const mockDb = require('../src/db/knex');
const kycService = require('../src/services/kycService');
const migration = require('../src/db/migrations/20260425_add_kyc_status');

describe('KYC Service Database Persistence', () => {
  let originalMockImpl;

  beforeAll(async () => {
    // Save original mock implementation
    originalMockImpl = mockDb.getMockImplementation();

    // Delegate mock Knex calls to the real Knex instance
    mockDb.mockImplementation((table) => realDb(table));
    mockDb.raw = realDb.raw;
    mockDb.schema = realDb.schema;
    mockDb.migrate = realDb.migrate;

    // Run the KYC status table migration on the real DB
    await migration.up(realDb);
  });

  afterAll(async () => {
    // Restore the original mock implementation for other tests
    mockDb.mockImplementation(originalMockImpl);
    
    // Close the real database connection
    await realDb.destroy();
  });

  beforeEach(async () => {
    // Clean database records and reset mock state before each test
    await realDb('kyc_records').del();
    kycService.resetMockRecords();
  });

  it('should return pending status for an unknown SME', async () => {
    const result = await kycService.getKycStatus('unknown_sme');
    expect(result.status).toBe(kycService.KYC_STATUSES.PENDING);
  });

  it('should persist verification status to the database', async () => {
    const smeId = 'sme_persist_01';
    const verifyResult = await kycService.verifySmeSafe(smeId);
    expect(verifyResult.status).toBe(kycService.KYC_STATUSES.VERIFIED);

    // Verify it is in the database
    const dbRecord = await realDb('kyc_records').where({ sme_id: smeId }).first();
    expect(dbRecord).toBeDefined();
    expect(dbRecord.status).toBe(kycService.KYC_STATUSES.VERIFIED);
    expect(dbRecord.provider_record_id).toBe(verifyResult.recordId);
  });

  it('should survive a restart (clearing mock store does not lose KYC status)', async () => {
    const smeId = 'sme_restart_01';
    
    // 1. Verify SME (marks in DB and mock store)
    await kycService.verifySmeSafe(smeId);
    
    // 2. Clear mock in-memory store to simulate process restart
    kycService.resetMockRecords();
    
    // 3. Status should still be retrieved from DB
    const result = await kycService.getKycStatus(smeId);
    expect(result.status).toBe(kycService.KYC_STATUSES.VERIFIED);
    expect(result.recordId).toBeDefined();
  });

  it('should persist reject status to the database', async () => {
    const smeId = 'sme_reject_01';
    const rejectResult = await kycService.rejectSmeKyc(smeId, 'High-risk business');
    expect(rejectResult.status).toBe(kycService.KYC_STATUSES.REJECTED);

    // Verify it is in the database
    const dbRecord = await realDb('kyc_records').where({ sme_id: smeId }).first();
    expect(dbRecord).toBeDefined();
    expect(dbRecord.status).toBe(kycService.KYC_STATUSES.REJECTED);

    // Verify subsequent lookup gets rejection
    kycService.resetMockRecords();
    const lookup = await kycService.getKycStatus(smeId);
    expect(lookup.status).toBe(kycService.KYC_STATUSES.REJECTED);
  });

  it('should persist exemption status to the database', async () => {
    const smeId = 'sme_exempt_01';
    const exemptResult = await kycService.exemptSmeFromKyc(smeId, 'Government entity');
    expect(exemptResult.status).toBe(kycService.KYC_STATUSES.EXEMPTED);

    // Verify it is in the database
    const dbRecord = await realDb('kyc_records').where({ sme_id: smeId }).first();
    expect(dbRecord).toBeDefined();
    expect(dbRecord.status).toBe(kycService.KYC_STATUSES.EXEMPTED);

    // Verify subsequent lookup gets exemption
    kycService.resetMockRecords();
    const lookup = await kycService.getKycStatus(smeId);
    expect(lookup.status).toBe(kycService.KYC_STATUSES.EXEMPTED);
  });

  it('should be idempotent (re-verifying a verified SME is safe and updates the record)', async () => {
    const smeId = 'sme_idempotent_01';
    
    // First verification
    const res1 = await kycService.verifySmeSafe(smeId);
    const dbRecord1 = await realDb('kyc_records').where({ sme_id: smeId }).first();
    
    // Second verification
    const res2 = await kycService.verifySmeSafe(smeId);
    const dbRecord2 = await realDb('kyc_records').where({ sme_id: smeId }).first();

    expect(res1.status).toBe(kycService.KYC_STATUSES.VERIFIED);
    expect(res2.status).toBe(kycService.KYC_STATUSES.VERIFIED);
    
    // Verify records got updated/saved without throwing duplicate key errors
    expect(dbRecord2.sme_id).toBe(dbRecord1.sme_id);
    expect(dbRecord2.status).toBe(dbRecord1.status);
  });
});
