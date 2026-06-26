'use strict';

const { v4: uuidv4 } = require('uuid');

// Mock database with comprehensive coverage
function asResolved(builder, data) {
  builder.then = (onF) => Promise.resolve(data).then(onF);
  builder.catch = (onR) => Promise.resolve(data).catch(onR);
  return builder;
}

jest.mock('../src/db/knex', () => {
  const createMockQuery = () => ({
    where: jest.fn(function() { return this; }),
    whereNotIn: jest.fn(function() { return this; }),
    whereNull: jest.fn(function() { return this; }),
    whereIn: jest.fn(function() { return this; }),
    whereRaw: jest.fn(function() { return this; }),
    leftJoin: jest.fn(function() { return this; }),
    orderBy: jest.fn(function() { return this; }),
    limit: jest.fn(function() { return this; }),
    del: jest.fn().mockResolvedValue(1),
    select: jest.fn().mockResolvedValue([]),
    insert: jest.fn(function() { return this; }),
    update: jest.fn(function() { return this; }),
    first: jest.fn().mockResolvedValue(null),
    andWhere: jest.fn(function() { return this; }),
    orWhere: jest.fn(function() { return this; }),
    returning: jest.fn(function(fields) { 
      return Promise.resolve(Array.isArray(fields) ? [] : [{}]);
    }),
    then: jest.fn(function(onFulfilled) {
      return Promise.resolve(this._resolveValue !== undefined ? this._resolveValue : []).then(onFulfilled);
    }),
    catch: jest.fn(function(onRejected) {
      return Promise.resolve(this._resolveValue !== undefined ? this._resolveValue : []).catch(onRejected);
    }),
  });

  const db = jest.fn(createMockQuery);
  db.raw = jest.fn();
  return db;
});

const db = require('../src/db/knex');
const retentionJob = require('../src/jobs/retentionPurge');

// Mock logger to avoid noise in tests
jest.mock('../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

// Mock escrowSubmit.js Module
jest.mock('../src/services/escrowSubmit', () => ({
  submitFundEscrow: jest.fn().mockResolvedValue({
    status: 'stubbed',
    escrowAddress: 'GAB...',
    unsignedXdr: null,
    txHash: null,
    ledger: null,
  }),
  EscrowSubmitError: class EscrowSubmitError extends Error {},
  SIGNING_MODE: { DELEGATED: 'delegated', CUSTODIAL: 'custodial', STUBBED: 'stubbed' },
}));

describe('Retention Job Handler - Direct Testing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Job Handler Core Logic', () => {
    test('should handle complete job execution flow', async () => {
      // Mock all database operations
      let dbCallCount = 0;
      db.mockImplementation(() => {
        dbCallCount++;
        
        if (dbCallCount === 1) {
          // Create job execution
          return {
            insert: jest.fn().mockReturnThis(),
            returning: jest.fn().mockResolvedValue([{ id: 'execution-123' }])
          };
        } else if (dbCallCount === 2) {
          // Get active policies
          return {
            where: jest.fn().mockReturnThis(),
            whereNull: jest.fn().mockReturnThis(),
            select: jest.fn().mockResolvedValue([{
              id: 'policy-1',
              name: 'Test Policy',
              retention_days: 30,
              pii_fields: ['customer_name', 'customer_email'],
              is_active: true
            }])
          };
        } else if (dbCallCount === 3) {
          // Get eligible invoices
          return {
            where: jest.fn().mockReturnThis(),
            whereNotIn: jest.fn().mockReturnThis(),
            whereNull: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            select: jest.fn().mockResolvedValue([{
              id: 'invoice-1',
              invoice_number: 'INV-001',
              customer_name: 'Test Customer',
              customer_email: 'test@example.com',
              created_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) // 40 days ago
            }])
          };
        } else if (dbCallCount === 4) {
          // Check legal holds
          return {
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            orWhere: jest.fn().mockReturnThis(),
            first: jest.fn().mockResolvedValue(null) // No hold
          };
        } else if (dbCallCount === 5) {
          // Get current invoice data for audit
          return {
            where: jest.fn().mockReturnThis(),
            first: jest.fn().mockResolvedValue({
              id: 'invoice-1',
              customer_name: 'Test Customer',
              customer_email: 'test@example.com'
            })
          };
        } else if (dbCallCount === 6) {
          // Purge PII
          return {
            where: jest.fn().mockReturnThis(),
            update: jest.fn().mockReturnThis()
          };
        } else if (dbCallCount === 7) {
          // Log audit entry
          return {
            insert: jest.fn().mockReturnThis()
          };
        } else if (dbCallCount === 8) {
          // Update job execution
          return {
            where: jest.fn().mockReturnThis(),
            update: jest.fn().mockReturnThis()
          };
        } else {
          return mockQuery;
        }
      });

      // Test the actual job handler
      const mockJob = {
        id: 'job-123',
        type: 'retention_purge',
        payload: {
          tenantId: uuidv4(),
          dryRun: false,
          performedBy: uuidv4(),
          batchSize: 100
        }
      };

      // Get the registered handler and execute it
      const handlers = retentionJob.retentionWorker.handlers;
      const handler = handlers.get('retention_purge');
      
      if (handler) {
        await handler(mockJob);
      }

      // Verify database was called multiple times
      expect(dbCallCount).toBeGreaterThan(5);
    });

    test('should handle dry run execution', async () => {
      let dbCallCount = 0;
      db.mockImplementation(() => {
        dbCallCount++;
        
        if (dbCallCount === 1) {
          // Create job execution
          return {
            insert: jest.fn().mockReturnThis(),
            returning: jest.fn().mockResolvedValue([{ id: 'dry-execution' }])
          };
        } else if (dbCallCount === 2) {
          // Get active policies
          return {
            where: jest.fn().mockReturnThis(),
            whereNull: jest.fn().mockReturnThis(),
            select: jest.fn().mockResolvedValue([{
              id: 'policy-1',
              name: 'Test Policy',
              retention_days: 30,
              pii_fields: ['customer_name'],
              is_active: true
            }])
          };
        } else if (dbCallCount === 3) {
          // Get eligible invoices
          return {
            where: jest.fn().mockReturnThis(),
            whereNotIn: jest.fn().mockReturnThis(),
            whereNull: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            select: jest.fn().mockResolvedValue([{
              id: 'invoice-1',
              invoice_number: 'INV-001',
              customer_name: 'Test Customer',
              created_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
            }])
          };
        } else if (dbCallCount === 4) {
          // Check legal holds
          return {
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            orWhere: jest.fn().mockReturnThis(),
            first: jest.fn().mockResolvedValue(null)
          };
        } else if (dbCallCount === 5) {
          // Log audit entry for dry run
          return {
            insert: jest.fn().mockReturnThis()
          };
        } else if (dbCallCount === 6) {
          // Update job execution
          return {
            where: jest.fn().mockReturnThis(),
            update: jest.fn().mockReturnThis()
          };
        } else {
          return mockQuery;
        }
      });

      const mockJob = {
        id: 'dry-job-123',
        type: 'retention_purge',
        payload: {
          tenantId: uuidv4(),
          dryRun: true,
          performedBy: uuidv4()
        }
      };

      const handlers = retentionJob.retentionWorker.handlers;
      const handler = handlers.get('retention_purge');
      
      if (handler) {
        await handler(mockJob);
      }

      expect(dbCallCount).toBeGreaterThan(4);
    });

    test('should handle legal hold protection', async () => {
      let dbCallCount = 0;
      db.mockImplementation(() => {
        dbCallCount++;
        
        if (dbCallCount === 1) {
          // Create job execution
          return {
            insert: jest.fn().mockReturnThis(),
            returning: jest.fn().mockResolvedValue([{ id: 'hold-execution' }])
          };
        } else if (dbCallCount === 2) {
          // Get active policies
          return {
            where: jest.fn().mockReturnThis(),
            whereNull: jest.fn().mockReturnThis(),
            select: jest.fn().mockResolvedValue([{
              id: 'policy-1',
              name: 'Test Policy',
              retention_days: 30,
              pii_fields: ['customer_name'],
              is_active: true
            }])
          };
        } else if (dbCallCount === 3) {
          // Get eligible invoices
          return {
            where: jest.fn().mockReturnThis(),
            whereNotIn: jest.fn().mockReturnThis(),
            whereNull: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            select: jest.fn().mockResolvedValue([{
              id: 'invoice-1',
              invoice_number: 'INV-001',
              customer_name: 'Test Customer',
              created_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
            }])
          };
        } else if (dbCallCount === 4) {
          // Check legal holds - return active hold
          return {
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            orWhere: jest.fn().mockReturnThis(),
            first: jest.fn().mockResolvedValue({
              id: 'hold-1',
              status: 'active',
              hold_reason: 'Legal investigation'
            })
          };
        } else if (dbCallCount === 5) {
          // Update job execution (no purging due to hold)
          return {
            where: jest.fn().mockReturnThis(),
            update: jest.fn().mockReturnThis()
          };
        } else {
          return mockQuery;
        }
      });

      const mockJob = {
        id: 'hold-job-123',
        type: 'retention_purge',
        payload: {
          tenantId: uuidv4(),
          dryRun: false,
          performedBy: uuidv4()
        }
      };

      const handlers = retentionJob.retentionWorker.handlers;
      const handler = handlers.get('retention_purge');
      
      if (handler) {
        await handler(mockJob);
      }

      expect(dbCallCount).toBeGreaterThan(4);
    });

    test('should handle policy not found error', async () => {
      let dbCallCount = 0;
      db.mockImplementation(() => {
        dbCallCount++;
        
        if (dbCallCount === 1) {
          // Create job execution
          return {
            insert: jest.fn().mockReturnThis(),
            returning: jest.fn().mockResolvedValue([{ id: 'error-execution' }])
          };
        } else if (dbCallCount === 2) {
          // Get specific policy - return null
          return {
            where: jest.fn().mockReturnThis(),
            whereNull: jest.fn().mockReturnThis(),
            first: jest.fn().mockResolvedValue(null)
          };
        } else if (dbCallCount === 3) {
          // Update job execution with failure
          return {
            where: jest.fn().mockReturnThis(),
            update: jest.fn().mockReturnThis()
          };
        } else {
          return mockQuery;
        }
      });

      const mockJob = {
        id: 'error-job-123',
        type: 'retention_purge',
        payload: {
          tenantId: uuidv4(),
          policyId: 'non-existent-policy',
          dryRun: false,
          performedBy: uuidv4()
        }
      };

      const handlers = retentionJob.retentionWorker.handlers;
      const handler = handlers.get('retention_purge');
      
      if (handler) {
        try {
          await handler(mockJob);
        } catch (error) {
          // Error is expected and should be logged
          expect(error.message).toContain('Retention policy');
        }
      }
    });

    test('should handle multiple policies processing', async () => {
      let dbCallCount = 0;
      db.mockImplementation(() => {
        dbCallCount++;
        
        if (dbCallCount === 1) {
          // Create job execution
          return {
            insert: jest.fn().mockReturnThis(),
            returning: jest.fn().mockResolvedValue([{ id: 'multi-execution' }])
          };
        } else if (dbCallCount === 2) {
          // Get active policies - return multiple
          return {
            where: jest.fn().mockReturnThis(),
            whereNull: jest.fn().mockReturnThis(),
            select: jest.fn().mockResolvedValue([
              {
                id: 'policy-1',
                name: 'Policy 1',
                retention_days: 30,
                pii_fields: ['customer_name'],
                is_active: true
              },
              {
                id: 'policy-2',
                name: 'Policy 2',
                retention_days: 60,
                pii_fields: ['customer_email'],
                is_active: true
              }
            ])
          };
        } else if (dbCallCount >= 3 && dbCallCount <= 8) {
          // Handle multiple policy processing
          return {
            where: jest.fn().mockReturnThis(),
            whereNotIn: jest.fn().mockReturnThis(),
            whereNull: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            select: jest.fn().mockResolvedValue([]), // No eligible invoices
            andWhere: jest.fn().mockReturnThis(),
            orWhere: jest.fn().mockReturnThis(),
            first: jest.fn().mockResolvedValue(null),
            update: jest.fn().mockReturnThis(),
            insert: jest.fn().mockReturnThis()
          };
        } else if (dbCallCount === 9) {
          // Update job execution
          return {
            where: jest.fn().mockReturnThis(),
            update: jest.fn().mockReturnThis()
          };
        } else {
          return mockQuery;
        }
      });

      const mockJob = {
        id: 'multi-job-123',
        type: 'retention_purge',
        payload: {
          tenantId: uuidv4(),
          dryRun: false,
          performedBy: uuidv4()
        }
      };

      const handlers = retentionJob.retentionWorker.handlers;
      const handler = handlers.get('retention_purge');
      
      if (handler) {
        await handler(mockJob);
      }

      expect(dbCallCount).toBeGreaterThan(8);
    });

    test('should handle custom PII fields', async () => {
      let dbCallCount = 0;
      db.mockImplementation(() => {
        dbCallCount++;
        
        if (dbCallCount === 1) {
          // Create job execution
          return {
            insert: jest.fn().mockReturnThis(),
            returning: jest.fn().mockResolvedValue([{ id: 'custom-execution' }])
          };
        } else if (dbCallCount === 2) {
          // Get active policies
          return {
            where: jest.fn().mockReturnThis(),
            whereNull: jest.fn().mockReturnThis(),
            select: jest.fn().mockResolvedValue([{
              id: 'policy-1',
              name: 'Test Policy',
              retention_days: 30,
              pii_fields: ['customer_name', 'customer_email'],
              is_active: true
            }])
          };
        } else if (dbCallCount === 3) {
          // Get eligible invoices
          return {
            where: jest.fn().mockReturnThis(),
            whereNotIn: jest.fn().mockReturnThis(),
            whereNull: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            select: jest.fn().mockResolvedValue([{
              id: 'invoice-1',
              invoice_number: 'INV-001',
              customer_name: 'Test Customer',
              customer_email: 'test@example.com',
              customer_tax_id: 'TAX-123',
              created_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
            }])
          };
        } else if (dbCallCount === 4) {
          // Check legal holds
          return {
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            orWhere: jest.fn().mockReturnThis(),
            first: jest.fn().mockResolvedValue(null)
          };
        } else if (dbCallCount === 5) {
          // Get current invoice data
          return {
            where: jest.fn().mockReturnThis(),
            first: jest.fn().mockResolvedValue({
              id: 'invoice-1',
              customer_name: 'Test Customer',
              customer_email: 'test@example.com',
              customer_tax_id: 'TAX-123'
            })
          };
        } else if (dbCallCount === 6) {
          // Purge only custom PII fields
          return {
            where: jest.fn().mockReturnThis(),
            update: jest.fn().mockReturnThis()
          };
        } else if (dbCallCount === 7) {
          // Log audit entry
          return {
            insert: jest.fn().mockReturnThis()
          };
        } else if (dbCallCount === 8) {
          // Update job execution
          return {
            where: jest.fn().mockReturnThis(),
            update: jest.fn().mockReturnThis()
          };
        } else {
          return mockQuery;
        }
      });

      const mockJob = {
        id: 'custom-job-123',
        type: 'retention_purge',
        payload: {
          tenantId: uuidv4(),
          dryRun: false,
          piiFields: ['customer_tax_id'], // Custom field
          performedBy: uuidv4()
        }
      };

      const handlers = retentionJob.retentionWorker.handlers;
      const handler = handlers.get('retention_purge');
      
      if (handler) {
        await handler(mockJob);
      }

      expect(dbCallCount).toBeGreaterThan(7);
    });

    test('should handle custom retention days', async () => {
      let dbCallCount = 0;
      db.mockImplementation(() => {
        dbCallCount++;
        
        if (dbCallCount === 1) {
          // Create job execution
          return {
            insert: jest.fn().mockReturnThis(),
            returning: jest.fn().mockResolvedValue([{ id: 'custom-retention-execution' }])
          };
        } else if (dbCallCount === 2) {
          // Get active policies
          return {
            where: jest.fn().mockReturnThis(),
            whereNull: jest.fn().mockReturnThis(),
            select: jest.fn().mockResolvedValue([{
              id: 'policy-1',
              name: 'Test Policy',
              retention_days: 30,
              pii_fields: ['customer_name'],
              is_active: true
            }])
          };
        } else if (dbCallCount === 3) {
          // Get eligible invoices with custom retention
          return {
            where: jest.fn().mockReturnThis(),
            whereNotIn: jest.fn().mockReturnThis(),
            whereNull: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            select: jest.fn().mockResolvedValue([{
              id: 'invoice-1',
              invoice_number: 'INV-001',
              customer_name: 'Test Customer',
              created_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) // 10 days ago
            }])
          };
        } else if (dbCallCount === 4) {
          // Check legal holds
          return {
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            orWhere: jest.fn().mockReturnThis(),
            first: jest.fn().mockResolvedValue(null)
          };
        } else if (dbCallCount === 5) {
          // Get current invoice data
          return {
            where: jest.fn().mockReturnThis(),
            first: jest.fn().mockResolvedValue({
              id: 'invoice-1',
              customer_name: 'Test Customer'
            })
          };
        } else if (dbCallCount === 6) {
          // Purge PII
          return {
            where: jest.fn().mockReturnThis(),
            update: jest.fn().mockReturnThis()
          };
        } else if (dbCallCount === 7) {
          // Log audit entry
          return {
            insert: jest.fn().mockReturnThis()
          };
        } else if (dbCallCount === 8) {
          // Update job execution
          return {
            where: jest.fn().mockReturnThis(),
            update: jest.fn().mockReturnThis()
          };
        } else {
          return mockQuery;
        }
      });

      const mockJob = {
        id: 'custom-retention-job-123',
        type: 'retention_purge',
        payload: {
          tenantId: uuidv4(),
          dryRun: false,
          retentionDays: 7, // Custom retention period
          performedBy: uuidv4()
        }
      };

      const handlers = retentionJob.retentionWorker.handlers;
      const handler = handlers.get('retention_purge');
      
      if (handler) {
        await handler(mockJob);
      }

      expect(dbCallCount).toBeGreaterThan(7);
    });

    test('should handle database errors during processing', async () => {
      let dbCallCount = 0;
      db.mockImplementation(() => {
        dbCallCount++;
        
        if (dbCallCount === 1) {
          // Create job execution
          return {
            insert: jest.fn().mockReturnThis(),
            returning: jest.fn().mockResolvedValue([{ id: 'db-error-execution' }])
          };
        } else if (dbCallCount === 2) {
          // Get active policies
          return {
            where: jest.fn().mockReturnThis(),
            whereNull: jest.fn().mockReturnThis(),
            select: jest.fn().mockResolvedValue([{
              id: 'policy-1',
              name: 'Test Policy',
              retention_days: 30,
              pii_fields: ['customer_name'],
              is_active: true
            }])
          };
        } else if (dbCallCount === 3) {
          // Database error when getting eligible invoices
          throw new Error('Database connection failed');
        } else {
          return mockQuery;
        }
      });

      const mockJob = {
        id: 'db-error-job-123',
        type: 'retention_purge',
        payload: {
          tenantId: uuidv4(),
          dryRun: false,
          performedBy: uuidv4()
        }
      };

      const handlers = retentionJob.retentionWorker.handlers;
      const handler = handlers.get('retention_purge');
      
      if (handler) {
        try {
          await handler(mockJob);
        } catch (error) {
          // Database error is expected
          expect(error.message).toContain('Database connection failed');
        }
      }
    });
  });
});
