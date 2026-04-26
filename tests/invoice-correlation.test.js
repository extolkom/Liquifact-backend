'use strict';

const { validateInvoiceId } = require('../src/services/escrowRead');
const { validateFundingRequest } = require('../src/services/escrowSubmit');

describe('Invoice Correlation Validation', () => {
  const validIds = [
    'inv_123',
    'INV-ABC-001',
    'invoice.2024:001',
    'a',
    '123',
    'A'.repeat(128)
  ];

  const invalidIds = [
    '',
    ' ',
    '_starts_with_underscore',
    '.starts_with_dot',
    ':starts_with_colon',
    '-starts_with_hyphen',
    'inv 123',
    'inv/123',
    'a'.repeat(129),
    '#bad',
    '$bad'
  ];

  describe('escrowRead.validateInvoiceId', () => {
    validIds.forEach(id => {
      it(`accepts valid ID: ${id}`, () => {
        expect(validateInvoiceId(id).valid).toBe(true);
      });
    });

    invalidIds.forEach(id => {
      it(`rejects invalid ID: ${id}`, () => {
        expect(validateInvoiceId(id).valid).toBe(false);
      });
    });
  });

  describe('escrowSubmit.validateFundingRequest', () => {
    const basePayload = {
      funderPublicKey: 'GB7Y7A7A7A7A7A7A7A7A7A7A7A7A7A7A7A7A7A7A7A7A7A7A7A7A7A7A',
      amount: '100.00',
      assetCode: 'XLM'
    };

    validIds.forEach(id => {
      it(`accepts valid invoiceId: ${id}`, () => {
        const payload = { ...basePayload, invoiceId: id };
        const result = validateFundingRequest(payload);
        expect(result.invoiceId).toBe(id);
      });
    });

    invalidIds.forEach(id => {
      it(`rejects invalid invoiceId: ${id}`, () => {
        const payload = { ...basePayload, invoiceId: id };
        expect(() => validateFundingRequest(payload)).toThrow();
      });
    });
  });
});
