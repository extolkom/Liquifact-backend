/**
 * Comprehensive test suite for Invoice Verification Service.
 * Tests fraud checks, business rules, and security validations across all decision paths.
 */

const { verifyInvoice } = require('../src/services/invoiceVerification');

describe('Invoice Verification Service - Comprehensive Decision Matrix', () => {
  // ============================================================================
  // GROUP 1: VERIFIED (Terminal Success Path)
  // ============================================================================
  describe('VERIFIED - successful invoice passes all checks', () => {
    it('should verify a valid invoice with standard amount', async () => {
      const payload = { amount: 5000, customer: 'Acme Corp' };
      const result = await verifyInvoice(payload);
      expect(result).toEqual({ status: 'VERIFIED' });
    });

    it('should verify invoice with minimum valid amount (0.01)', async () => {
      const payload = { amount: 0.01, customer: 'Test Customer' };
      const result = await verifyInvoice(payload);
      expect(result).toEqual({ status: 'VERIFIED' });
    });

    it('should verify invoice just below manual review threshold (999999.99)', async () => {
      const payload = {
        amount: 999999.99,
        customer: 'Large Customer',
      };
      const result = await verifyInvoice(payload);
      expect(result).toEqual({ status: 'VERIFIED' });
    });

    it('should verify invoice with customer name containing spaces and hyphens', async () => {
      const payload = {
        amount: 1500,
        customer: 'Smith & Co - NYC Branch',
      };
      const result = await verifyInvoice(payload);
      expect(result).toEqual({ status: 'VERIFIED' });
    });

    it('should verify invoice with customer name containing numbers', async () => {
      const payload = { amount: 2000, customer: 'Customer123' };
      const result = await verifyInvoice(payload);
      expect(result).toEqual({ status: 'VERIFIED' });
    });

    it('should verify invoice with customer name containing periods and commas', async () => {
      const payload = { amount: 3000, customer: 'Inc., LLC. Ltd' };
      const result = await verifyInvoice(payload);
      expect(result).toEqual({ status: 'VERIFIED' });
    });

    it('should require manual review for very large but valid amount (9999999)', async () => {
      const payload = { amount: 9999999, customer: 'Big Corp' };
      const result = await verifyInvoice(payload);
      // 9999999 >= 1000000, so it requires manual review
      expect(result).toEqual({
        status: 'MANUAL_REVIEW',
        reason: 'High value invoice requires manual approval',
      });
    });
  });

  // ============================================================================
  // GROUP 2: REJECTED - Invalid Payload Structure
  // ============================================================================
  describe('REJECTED - invalid payload structure', () => {
    it('should reject null payload', async () => {
      const result = await verifyInvoice(null);
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid payload structure',
      });
    });

    it('should reject undefined payload', async () => {
      const result = await verifyInvoice(undefined);
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid payload structure',
      });
    });

    it('should reject string payload', async () => {
      const result = await verifyInvoice('not an object');
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid payload structure',
      });
    });

    it('should reject number payload', async () => {
      const result = await verifyInvoice(12345);
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid payload structure',
      });
    });

    it('should reject boolean payload', async () => {
      const result = await verifyInvoice(true);
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid payload structure',
      });
    });

    it('should treat array as object (arrays are typeof "object" in JS)', async () => {
      const result = await verifyInvoice([5000, 'Acme Corp']);
      // Arrays are objects, so payload check passes; then amount check fails
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid amount: must be a positive number',
      });
    });
  });

  // ============================================================================
  // GROUP 3: REJECTED - Invalid Amount (Type and Boundary)
  // ============================================================================
  describe('REJECTED - invalid amount validation', () => {
    it('should reject amount as string', async () => {
      const result = await verifyInvoice({
        amount: '5000',
        customer: 'Acme Corp',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid amount: must be a positive number',
      });
    });

    it('should reject amount as boolean', async () => {
      const result = await verifyInvoice({
        amount: true,
        customer: 'Acme Corp',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid amount: must be a positive number',
      });
    });

    it('should reject amount as null', async () => {
      const result = await verifyInvoice({
        amount: null,
        customer: 'Acme Corp',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid amount: must be a positive number',
      });
    });

    it('should reject amount as array', async () => {
      const result = await verifyInvoice({
        amount: [5000],
        customer: 'Acme Corp',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid amount: must be a positive number',
      });
    });

    it('should reject amount as object', async () => {
      const result = await verifyInvoice({
        amount: { value: 5000 },
        customer: 'Acme Corp',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid amount: must be a positive number',
      });
    });

    it('should reject NaN amount', async () => {
      const result = await verifyInvoice({
        amount: NaN,
        customer: 'Acme Corp',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid amount: must be a positive number',
      });
    });

    it('should reject zero amount (boundary)', async () => {
      const result = await verifyInvoice({
        amount: 0,
        customer: 'Acme Corp',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid amount: must be a positive number',
      });
    });

    it('should reject negative amount', async () => {
      const result = await verifyInvoice({
        amount: -100,
        customer: 'Acme Corp',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid amount: must be a positive number',
      });
    });

    it('should reject very large negative amount', async () => {
      const result = await verifyInvoice({
        amount: -999999999,
        customer: 'Acme Corp',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid amount: must be a positive number',
      });
    });

    it('should reject -0 (negative zero)', async () => {
      const result = await verifyInvoice({
        amount: -0,
        customer: 'Acme Corp',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid amount: must be a positive number',
      });
    });

    it('should reject Infinity (exceeds max threshold)', async () => {
      const result = await verifyInvoice({
        amount: Infinity,
        customer: 'Acme Corp',
      });
      // Infinity is > 10000000, so it fails on max threshold check, not type check
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Amount exceeds maximum allowed threshold',
      });
    });

    it('should reject negative Infinity', async () => {
      const result = await verifyInvoice({
        amount: -Infinity,
        customer: 'Acme Corp',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid amount: must be a positive number',
      });
    });
  });

  // ============================================================================
  // GROUP 4: REJECTED - Invalid Customer (Type and Content)
  // ============================================================================
  describe('REJECTED - invalid customer validation', () => {
    it('should reject customer as number', async () => {
      const result = await verifyInvoice({
        amount: 5000,
        customer: 12345,
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid customer: must be a non-empty string',
      });
    });

    it('should reject customer as boolean', async () => {
      const result = await verifyInvoice({
        amount: 5000,
        customer: false,
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid customer: must be a non-empty string',
      });
    });

    it('should reject customer as null', async () => {
      const result = await verifyInvoice({
        amount: 5000,
        customer: null,
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid customer: must be a non-empty string',
      });
    });

    it('should reject customer as array', async () => {
      const result = await verifyInvoice({
        amount: 5000,
        customer: ['Acme', 'Corp'],
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid customer: must be a non-empty string',
      });
    });

    it('should reject customer as object', async () => {
      const result = await verifyInvoice({
        amount: 5000,
        customer: { name: 'Acme Corp' },
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid customer: must be a non-empty string',
      });
    });

    it('should reject empty customer string', async () => {
      const result = await verifyInvoice({
        amount: 5000,
        customer: '',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid customer: must be a non-empty string',
      });
    });

    it('should reject whitespace-only customer (spaces)', async () => {
      const result = await verifyInvoice({
        amount: 5000,
        customer: '   ',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid customer: must be a non-empty string',
      });
    });

    it('should reject whitespace-only customer (tabs)', async () => {
      const result = await verifyInvoice({
        amount: 5000,
        customer: '\t\t',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid customer: must be a non-empty string',
      });
    });

    it('should reject whitespace-only customer (newlines)', async () => {
      const result = await verifyInvoice({
        amount: 5000,
        customer: '\n\n',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid customer: must be a non-empty string',
      });
    });

    it('should reject whitespace-only customer (mixed)', async () => {
      const result = await verifyInvoice({
        amount: 5000,
        customer: ' \t\n ',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid customer: must be a non-empty string',
      });
    });
  });

  // ============================================================================
  // GROUP 5: REJECTED - Injection Pattern Detection (Security)
  // ============================================================================
  describe('REJECTED - injection pattern security validation', () => {
    it('should reject customer with HTML injection (<)', async () => {
      const result = await verifyInvoice({
        amount: 5000,
        customer: 'Acme<Corp',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Suspicious characters detected in customer data',
      });
    });

    it('should reject customer with HTML closing tag injection (>)', async () => {
      const result = await verifyInvoice({
        amount: 5000,
        customer: 'Acme>Corp',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Suspicious characters detected in customer data',
      });
    });

    it('should reject customer with script tag', async () => {
      const result = await verifyInvoice({
        amount: 5000,
        customer: '<script>alert("xss")</script>',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Suspicious characters detected in customer data',
      });
    });

    it('should reject customer with curly braces (template injection)', async () => {
      const result = await verifyInvoice({
        amount: 5000,
        customer: 'Acme{Corp}',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Suspicious characters detected in customer data',
      });
    });

    it('should reject customer with opening curly brace only', async () => {
      const result = await verifyInvoice({
        amount: 5000,
        customer: 'Acme{Corp',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Suspicious characters detected in customer data',
      });
    });

    it('should reject customer with closing curly brace only', async () => {
      const result = await verifyInvoice({
        amount: 5000,
        customer: 'AcmeCorp}',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Suspicious characters detected in customer data',
      });
    });

    it('should reject customer with dollar sign (variable injection)', async () => {
      const result = await verifyInvoice({
        amount: 5000,
        customer: 'Acme$Corp',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Suspicious characters detected in customer data',
      });
    });

    it('should reject customer with template literal syntax', async () => {
      const result = await verifyInvoice({
        amount: 5000,
        customer: '`Acme${Corp}`',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Suspicious characters detected in customer data',
      });
    });

    it('should reject customer with multiple injection patterns', async () => {
      const result = await verifyInvoice({
        amount: 5000,
        customer: '<Acme$Corp>',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Suspicious characters detected in customer data',
      });
    });

    it('should reject customer starting with suspicious character', async () => {
      const result = await verifyInvoice({
        amount: 5000,
        customer: '<Acme',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Suspicious characters detected in customer data',
      });
    });

    it('should reject customer ending with suspicious character', async () => {
      const result = await verifyInvoice({
        amount: 5000,
        customer: 'Acme>',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Suspicious characters detected in customer data',
      });
    });
  });

  // ============================================================================
  // GROUP 6: REJECTED - Amount Exceeds Maximum Threshold
  // ============================================================================
  describe('REJECTED - amount exceeds maximum threshold', () => {
    it('should require manual review at maximum threshold (10000000)', async () => {
      const result = await verifyInvoice({
        amount: 10000000,
        customer: 'Acme Corp',
      });
      // 10000000 >= 1000000, so manual review before max threshold check
      expect(result).toEqual({
        status: 'MANUAL_REVIEW',
        reason: 'High value invoice requires manual approval',
      });
    });

    it('should reject amount just above maximum threshold (10000000.01)', async () => {
      const result = await verifyInvoice({
        amount: 10000000.01,
        customer: 'Acme Corp',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Amount exceeds maximum allowed threshold',
      });
    });

    it('should reject very large amount (100000000)', async () => {
      const result = await verifyInvoice({
        amount: 100000000,
        customer: 'Acme Corp',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Amount exceeds maximum allowed threshold',
      });
    });

    it('should reject amount of 1e10 (scientific notation)', async () => {
      const result = await verifyInvoice({
        amount: 1e10,
        customer: 'Acme Corp',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Amount exceeds maximum allowed threshold',
      });
    });
  });

  // ============================================================================
  // GROUP 7: MANUAL_REVIEW - High Value Invoice (1M - 10M Range)
  // ============================================================================
  describe('MANUAL_REVIEW - high value invoice threshold', () => {
    it('should require manual review at minimum threshold (1000000)', async () => {
      const result = await verifyInvoice({
        amount: 1000000,
        customer: 'Large Corp',
      });
      expect(result).toEqual({
        status: 'MANUAL_REVIEW',
        reason: 'High value invoice requires manual approval',
      });
    });

    it('should require manual review just above minimum threshold (1000000.01)', async () => {
      const result = await verifyInvoice({
        amount: 1000000.01,
        customer: 'Large Corp',
      });
      expect(result).toEqual({
        status: 'MANUAL_REVIEW',
        reason: 'High value invoice requires manual approval',
      });
    });

    it('should require manual review at mid-range (5000000)', async () => {
      const result = await verifyInvoice({
        amount: 5000000,
        customer: 'Enterprise Corp',
      });
      expect(result).toEqual({
        status: 'MANUAL_REVIEW',
        reason: 'High value invoice requires manual approval',
      });
    });

    it('should require manual review just below maximum threshold (9999999.99)', async () => {
      const result = await verifyInvoice({
        amount: 9999999.99,
        customer: 'Mega Corp',
      });
      expect(result).toEqual({
        status: 'MANUAL_REVIEW',
        reason: 'High value invoice requires manual approval',
      });
    });

    it('should require manual review with valid customer in mid-range', async () => {
      const result = await verifyInvoice({
        amount: 2500000,
        customer: 'Global Holdings Inc.',
      });
      expect(result).toEqual({
        status: 'MANUAL_REVIEW',
        reason: 'High value invoice requires manual approval',
      });
    });
  });

  // ============================================================================
  // GROUP 8: Order of Validation - Early Exit Behavior
  // ============================================================================
  describe('validation order - early exit on first failure', () => {
    it('should reject invalid payload before checking amount', async () => {
      const result = await verifyInvoice(null);
      // Expects payload check, not amount check
      expect(result.reason).toBe('Invalid payload structure');
    });

    it('should check amount before customer when payload is valid', async () => {
      const result = await verifyInvoice({
        amount: 'invalid',
        customer: null, // also invalid
      });
      // Should fail on amount, not customer
      expect(result.reason).toBe('Invalid amount: must be a positive number');
    });

    it('should check customer validity before injection patterns', async () => {
      const result = await verifyInvoice({
        amount: 5000,
        customer: null, // invalid type before injection check
      });
      // Should fail on type, not injection
      expect(result.reason).toBe('Invalid customer: must be a non-empty string');
    });

    it('should check amount threshold before customer injection', async () => {
      const result = await verifyInvoice({
        amount: 15000000, // exceeds max
        customer: 'Normal<Customer', // has injection
      });
      // Should fail on amount, not injection
      expect(result.reason).toBe('Amount exceeds maximum allowed threshold');
    });

    it('should reach injection check after all other validations pass', async () => {
      const result = await verifyInvoice({
        amount: 5000,
        customer: 'Acme<Corp',
      });
      // Should fail on injection
      expect(result.reason).toBe('Suspicious characters detected in customer data');
    });
  });

  // ============================================================================
  // GROUP 9: Edge Cases and Boundary Conditions
  // ============================================================================
  describe('edge cases and boundary conditions', () => {
    it('should handle payload with extra fields gracefully', async () => {
      const result = await verifyInvoice({
        amount: 5000,
        customer: 'Acme Corp',
        extra: 'field',
        another: 123,
      });
      expect(result).toEqual({ status: 'VERIFIED' });
    });

    it('should handle payload with missing optional-looking fields', async () => {
      const result = await verifyInvoice({
        amount: 5000,
        customer: 'Acme Corp',
        // no extra fields
      });
      expect(result).toEqual({ status: 'VERIFIED' });
    });

    it('should treat undefined amount field as missing (falsy check)', async () => {
      const result = await verifyInvoice({
        amount: undefined,
        customer: 'Acme Corp',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid amount: must be a positive number',
      });
    });

    it('should treat undefined customer field as missing (falsy check)', async () => {
      const result = await verifyInvoice({
        amount: 5000,
        customer: undefined,
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid customer: must be a non-empty string',
      });
    });

    it('should handle very small positive amount (0.001)', async () => {
      const result = await verifyInvoice({
        amount: 0.001,
        customer: 'Micro Corp',
      });
      expect(result).toEqual({ status: 'VERIFIED' });
    });

    it('should handle very long customer name', async () => {
      const longName = 'A'.repeat(1000);
      const result = await verifyInvoice({
        amount: 5000,
        customer: longName,
      });
      expect(result).toEqual({ status: 'VERIFIED' });
    });

    it('should handle customer name with international characters', async () => {
      const result = await verifyInvoice({
        amount: 5000,
        customer: 'Société Générale',
      });
      expect(result).toEqual({ status: 'VERIFIED' });
    });

    it('should handle customer name with special safe characters (@ & # %)', async () => {
      const result = await verifyInvoice({
        amount: 5000,
        customer: 'Company @ Branch & Division #1',
      });
      expect(result).toEqual({ status: 'VERIFIED' });
    });
  });

  // ============================================================================
  // GROUP 10: Integration-Like Scenarios (Multiple Valid Invoices)
  // ============================================================================
  describe('integration scenarios - processing multiple invoices', () => {
    it('should verify batch of valid invoices independently', async () => {
      const invoices = [
        { amount: 100, customer: 'Customer A' },
        { amount: 50000, customer: 'Customer B' },
        { amount: 999999, customer: 'Customer C' },
      ];

      for (const invoice of invoices) {
        const result = await verifyInvoice(invoice);
        expect(result.status).toBe('VERIFIED');
      }
    });

    it('should handle mixed results from batch processing', async () => {
      const invoices = [
        { amount: 5000, customer: 'Valid Corp' }, // VERIFIED
        { amount: 0, customer: 'Invalid Corp' }, // REJECTED
        { amount: 5000000, customer: 'Large Corp' }, // MANUAL_REVIEW
      ];

      const results = await Promise.all(invoices.map((invoice) => verifyInvoice(invoice)));

      expect(results[0].status).toBe('VERIFIED');
      expect(results[1].status).toBe('REJECTED');
      expect(results[2].status).toBe('MANUAL_REVIEW');
    });
  });
});
