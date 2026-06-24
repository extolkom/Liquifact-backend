'use strict';

/**
 * tests/validation.test.js
 *
 * Comprehensive test suite for the Zod-backed invoice validation schemas
 * (src/schemas/invoice.js) and the adapter re-exported from
 * src/utils/validators.js.
 *
 * Coverage targets:
 *  - invoiceCreateSchema   (valid payloads, every required field missing,
 *                           type errors, string-length bounds, unknown keys,
 *                           currency normalisation)
 *  - invoiceUpdateSchema   (partial updates, unknown-key rejection)
 *  - paginationQuerySchema (defaults, coercion, boundary values)
 *  - validateInvoicePayload adapter (shape compatibility with old callers)
 *  - validateBody / validateQuery Express middleware
 *  - parseValidationErrors helper
 */

const {
  invoiceCreateSchema,
  invoiceUpdateSchema,
  paginationQuerySchema,
  validateInvoicePayload,
  validateBody,
  validateQuery,
  parseValidationErrors,
  SUPPORTED_CURRENCIES,
} = require('../src/schemas/invoice');

// Also ensure validators.js re-exports the adapter unchanged
const { validateInvoicePayload: vpFromValidators } = require('../src/utils/validators');

// ── Fixtures ─────────────────────────────────────────────────────────────────

const VALID_PAYLOAD = {
  amount: 1000.5,
  buyer: 'Acme Corp',
  seller: 'Globex Inc',
  dueDate: '2025-12-31',
  currency: 'USD',
};

// ─────────────────────────────────────────────────────────────────────────────
// invoiceCreateSchema
// ─────────────────────────────────────────────────────────────────────────────

describe('invoiceCreateSchema', () => {
  describe('valid payloads', () => {
    it('accepts a fully-specified payload', () => {
      const result = invoiceCreateSchema.safeParse({
        ...VALID_PAYLOAD,
        description: 'Q1 services',
        invoiceNumber: 'INV-001',
      });
      expect(result.success).toBe(true);
    });

    it('accepts customer as alias for buyer', () => {
      const payload = { ...VALID_PAYLOAD };
      delete payload.buyer;
      const result = invoiceCreateSchema.safeParse({ ...payload, customer: 'BigCo' });
      expect(result.success).toBe(true);
    });

    it('normalises currency to upper-case', () => {
      const result = invoiceCreateSchema.safeParse({ ...VALID_PAYLOAD, currency: 'usd' });
      expect(result.success).toBe(true);
      expect(result.data.currency).toBe('USD');
    });

    it('trims whitespace from buyer and seller', () => {
      const result = invoiceCreateSchema.safeParse({
        ...VALID_PAYLOAD,
        buyer: '  Acme  ',
        seller: '  Globex  ',
      });
      expect(result.success).toBe(true);
      expect(result.data.buyer).toBe('Acme');
      expect(result.data.seller).toBe('Globex');
    });
  });

  describe('required fields', () => {
    it('rejects missing amount', () => {
      const { amount, ...rest } = VALID_PAYLOAD;
      const result = invoiceCreateSchema.safeParse(rest);
      expect(result.success).toBe(false);
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('amount');
    });

    it('rejects missing buyer (no customer either)', () => {
      const { buyer, ...rest } = VALID_PAYLOAD;
      const result = invoiceCreateSchema.safeParse(rest);
      expect(result.success).toBe(false);
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('buyer');
    });

    it('rejects missing seller', () => {
      const { seller, ...rest } = VALID_PAYLOAD;
      const result = invoiceCreateSchema.safeParse(rest);
      expect(result.success).toBe(false);
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('seller');
    });

    it('rejects missing currency', () => {
      const { currency, ...rest } = VALID_PAYLOAD;
      const result = invoiceCreateSchema.safeParse(rest);
      expect(result.success).toBe(false);
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('currency');
    });

    it('rejects missing dueDate', () => {
      const { dueDate, ...rest } = VALID_PAYLOAD;
      const result = invoiceCreateSchema.safeParse(rest);
      expect(result.success).toBe(false);
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('dueDate');
    });

    it('reports all missing fields in one pass (empty object)', () => {
      const result = invoiceCreateSchema.safeParse({});
      expect(result.success).toBe(false);
      expect(result.error.issues.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('amount validation', () => {
    it('rejects zero', () => {
      const result = invoiceCreateSchema.safeParse({ ...VALID_PAYLOAD, amount: 0 });
      expect(result.success).toBe(false);
    });

    it('rejects negative amount', () => {
      const result = invoiceCreateSchema.safeParse({ ...VALID_PAYLOAD, amount: -1 });
      expect(result.success).toBe(false);
    });

    it('rejects Infinity', () => {
      const result = invoiceCreateSchema.safeParse({ ...VALID_PAYLOAD, amount: Infinity });
      expect(result.success).toBe(false);
    });

    it('rejects NaN', () => {
      const result = invoiceCreateSchema.safeParse({ ...VALID_PAYLOAD, amount: NaN });
      expect(result.success).toBe(false);
    });

    it('rejects string amount', () => {
      const result = invoiceCreateSchema.safeParse({ ...VALID_PAYLOAD, amount: '1000' });
      expect(result.success).toBe(false);
    });
  });

  describe('dueDate validation', () => {
    it('rejects wrong format (DD-MM-YYYY)', () => {
      const result = invoiceCreateSchema.safeParse({ ...VALID_PAYLOAD, dueDate: '31-12-2025' });
      expect(result.success).toBe(false);
    });

    it('rejects impossible date (month 13)', () => {
      const result = invoiceCreateSchema.safeParse({ ...VALID_PAYLOAD, dueDate: '2025-13-01' });
      expect(result.success).toBe(false);
    });

    it('rejects non-string date', () => {
      const result = invoiceCreateSchema.safeParse({ ...VALID_PAYLOAD, dueDate: 20251231 });
      expect(result.success).toBe(false);
    });
  });

  describe('buyer / seller string bounds', () => {
    it('rejects empty buyer', () => {
      const result = invoiceCreateSchema.safeParse({ ...VALID_PAYLOAD, buyer: '' });
      expect(result.success).toBe(false);
    });

    it('rejects buyer longer than 255 chars', () => {
      const result = invoiceCreateSchema.safeParse({ ...VALID_PAYLOAD, buyer: 'A'.repeat(256) });
      expect(result.success).toBe(false);
    });

    it('rejects empty seller', () => {
      const result = invoiceCreateSchema.safeParse({ ...VALID_PAYLOAD, seller: '   ' });
      expect(result.success).toBe(false);
    });

    it('rejects seller longer than 255 chars', () => {
      const result = invoiceCreateSchema.safeParse({ ...VALID_PAYLOAD, seller: 'S'.repeat(256) });
      expect(result.success).toBe(false);
    });
  });

  describe('currency validation', () => {
    it('rejects unsupported code', () => {
      const result = invoiceCreateSchema.safeParse({ ...VALID_PAYLOAD, currency: 'XYZ' });
      expect(result.success).toBe(false);
    });

    it('rejects 2-letter code', () => {
      const result = invoiceCreateSchema.safeParse({ ...VALID_PAYLOAD, currency: 'US' });
      expect(result.success).toBe(false);
    });

    it('rejects 4-letter code', () => {
      const result = invoiceCreateSchema.safeParse({ ...VALID_PAYLOAD, currency: 'USDD' });
      expect(result.success).toBe(false);
    });

    it('accepts every listed currency', () => {
      for (const code of SUPPORTED_CURRENCIES) {
        const result = invoiceCreateSchema.safeParse({ ...VALID_PAYLOAD, currency: code });
        expect(result.success).toBe(true);
      }
    });
  });

  describe('optional field bounds', () => {
    it('rejects description longer than 1000 chars', () => {
      const result = invoiceCreateSchema.safeParse({
        ...VALID_PAYLOAD,
        description: 'D'.repeat(1001),
      });
      expect(result.success).toBe(false);
    });

    it('rejects invoiceNumber longer than 100 chars', () => {
      const result = invoiceCreateSchema.safeParse({
        ...VALID_PAYLOAD,
        invoiceNumber: 'N'.repeat(101),
      });
      expect(result.success).toBe(false);
    });
  });

  describe('unknown key rejection (.strict)', () => {
    it('rejects a payload with unknown keys', () => {
      const result = invoiceCreateSchema.safeParse({
        ...VALID_PAYLOAD,
        __proto__: {},
        constructor: 'evil',
        extraField: 'sneaky',
      });
      expect(result.success).toBe(false);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// invoiceUpdateSchema
// ─────────────────────────────────────────────────────────────────────────────

describe('invoiceUpdateSchema', () => {
  it('accepts an empty object (full partial update)', () => {
    const result = invoiceUpdateSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts a partial update with only amount', () => {
    const result = invoiceUpdateSchema.safeParse({ amount: 500 });
    expect(result.success).toBe(true);
    expect(result.data.amount).toBe(500);
  });

  it('rejects negative amount on update', () => {
    const result = invoiceUpdateSchema.safeParse({ amount: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys', () => {
    const result = invoiceUpdateSchema.safeParse({ hack: true });
    expect(result.success).toBe(false);
  });

  it('accepts valid status on update', () => {
    const result = invoiceUpdateSchema.safeParse({ status: 'paid' });
    expect(result.success).toBe(true);
  });

  it('rejects invalid status on update', () => {
    const result = invoiceUpdateSchema.safeParse({ status: 'deleted' });
    expect(result.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// paginationQuerySchema
// ─────────────────────────────────────────────────────────────────────────────

describe('paginationQuerySchema', () => {
  it('applies defaults when nothing is provided', () => {
    const result = paginationQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.data.page).toBe(1);
    expect(result.data.limit).toBe(20);
  });

  it('coerces string page to number', () => {
    const result = paginationQuerySchema.safeParse({ page: '3' });
    expect(result.success).toBe(true);
    expect(result.data.page).toBe(3);
  });

  it('rejects page = 0', () => {
    const result = paginationQuerySchema.safeParse({ page: '0' });
    expect(result.success).toBe(false);
  });

  it('rejects negative page', () => {
    const result = paginationQuerySchema.safeParse({ page: '-1' });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer page (1.5)', () => {
    const result = paginationQuerySchema.safeParse({ page: '1.5' });
    expect(result.success).toBe(false);
  });

  it('rejects limit = 0', () => {
    const result = paginationQuerySchema.safeParse({ limit: '0' });
    expect(result.success).toBe(false);
  });

  it('rejects limit > 100', () => {
    const result = paginationQuerySchema.safeParse({ limit: '101' });
    expect(result.success).toBe(false);
  });

  it('accepts limit = 100 (boundary)', () => {
    const result = paginationQuerySchema.safeParse({ limit: '100' });
    expect(result.success).toBe(true);
    expect(result.data.limit).toBe(100);
  });

  it('rejects invalid status', () => {
    const result = paginationQuerySchema.safeParse({ status: 'unknown' });
    expect(result.success).toBe(false);
  });

  it('accepts valid status values', () => {
    for (const s of ['paid', 'pending', 'overdue']) {
      expect(paginationQuerySchema.safeParse({ status: s }).success).toBe(true);
    }
  });

  it('rejects invalid dateFrom format', () => {
    const result = paginationQuerySchema.safeParse({ dateFrom: '01-01-2025' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid order value', () => {
    const result = paginationQuerySchema.safeParse({ order: 'sideways' });
    expect(result.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateInvoicePayload adapter
// ─────────────────────────────────────────────────────────────────────────────

describe('validateInvoicePayload', () => {
  it('returns isValid=true and non-empty validatedPayload for a valid body', () => {
    const { isValid, errors, validatedPayload } = validateInvoicePayload(VALID_PAYLOAD);
    expect(isValid).toBe(true);
    expect(errors).toHaveLength(0);
    expect(validatedPayload.amount).toBe(1000.5);
    expect(validatedPayload.currency).toBe('USD');
  });

  it('returns isValid=false and errors array for missing amount', () => {
    const { amount, ...rest } = VALID_PAYLOAD;
    const { isValid, errors } = validateInvoicePayload(rest);
    expect(isValid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => /amount/i.test(e))).toBe(true);
  });

  it('returns isValid=false for negative amount', () => {
    const { isValid, errors } = validateInvoicePayload({ ...VALID_PAYLOAD, amount: -5 });
    expect(isValid).toBe(false);
    expect(errors.some((e) => /amount/i.test(e))).toBe(true);
  });

  it('returns isValid=false for missing buyer', () => {
    const { buyer, ...rest } = VALID_PAYLOAD;
    const { isValid, errors } = validateInvoicePayload(rest);
    expect(isValid).toBe(false);
    expect(errors.some((e) => /buyer/i.test(e))).toBe(true);
  });

  it('returns isValid=false for unsupported currency', () => {
    const { isValid, errors } = validateInvoicePayload({ ...VALID_PAYLOAD, currency: 'FOO' });
    expect(isValid).toBe(false);
    expect(errors.some((e) => /currency/i.test(e))).toBe(true);
  });

  it('returns isValid=false for oversized description', () => {
    const { isValid, errors } = validateInvoicePayload({
      ...VALID_PAYLOAD,
      description: 'X'.repeat(1001),
    });
    expect(isValid).toBe(false);
    expect(errors.some((e) => /description/i.test(e))).toBe(true);
  });

  it('returns isValid=false for non-object body (null)', () => {
    const { isValid, errors } = validateInvoicePayload(null);
    expect(isValid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('returns isValid=false for array body', () => {
    const { isValid } = validateInvoicePayload([]);
    expect(isValid).toBe(false);
  });

  it('rejects unknown keys (prototype-pollution attempt)', () => {
    const { isValid, errors } = validateInvoicePayload({
      ...VALID_PAYLOAD,
      __proto__: { admin: true },
    });
    expect(isValid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('is the same function as re-exported from validators.js', () => {
    expect(vpFromValidators).toBe(validateInvoicePayload);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseValidationErrors helper
// ─────────────────────────────────────────────────────────────────────────────

describe('parseValidationErrors', () => {
  it('maps each issue path to the first error message', () => {
    const parseResult = invoiceCreateSchema.safeParse({});
    expect(parseResult.success).toBe(false);
    const fieldErrors = parseValidationErrors(parseResult.error);
    expect(typeof fieldErrors).toBe('object');
    // amount must be flagged
    expect(fieldErrors['amount']).toBeDefined();
  });

  it('uses _root for issues with empty path', () => {
    const { ZodError } = require('zod');
    const fakeError = new ZodError([
      { code: 'custom', message: 'top-level error', path: [] },
    ]);
    const result = parseValidationErrors(fakeError);
    expect(result['_root']).toBe('top-level error');
  });

  it('handles nested paths with dot notation', () => {
    const { ZodError } = require('zod');
    const fakeError = new ZodError([
      { code: 'custom', message: 'nested error', path: ['a', 'b'] },
    ]);
    const result = parseValidationErrors(fakeError);
    expect(result['a.b']).toBe('nested error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateBody middleware
// ─────────────────────────────────────────────────────────────────────────────

describe('validateBody middleware', () => {
  const mockNext = jest.fn();

  beforeEach(() => mockNext.mockClear());

  function makeReqRes(body) {
    const req = { body };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    return { req, res };
  }

  it('calls next() and attaches req.validated on valid body', () => {
    const { req, res } = makeReqRes(VALID_PAYLOAD);
    validateBody(invoiceCreateSchema)(req, res, mockNext);
    expect(mockNext).toHaveBeenCalledWith();
    expect(req.validated).toBeDefined();
    expect(req.validated.amount).toBe(1000.5);
  });

  it('returns 400 RFC 7807 response on invalid body', () => {
    const { req, res } = makeReqRes({ amount: -1 });
    validateBody(invoiceCreateSchema)(req, res, mockNext);
    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0][0];
    expect(body.type).toMatch(/validation-error/);
    expect(body.fieldErrors).toBeDefined();
    expect(mockNext).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateQuery middleware
// ─────────────────────────────────────────────────────────────────────────────

describe('validateQuery middleware', () => {
  const mockNext = jest.fn();
  beforeEach(() => mockNext.mockClear());

  function makeReqRes(query) {
    const req = { query };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    return { req, res };
  }

  it('calls next() and attaches req.validatedQuery on valid query', () => {
    const { req, res } = makeReqRes({ page: '1', limit: '20' });
    validateQuery(paginationQuerySchema)(req, res, mockNext);
    expect(mockNext).toHaveBeenCalledWith();
    expect(req.validatedQuery.page).toBe(1);
  });

  it('returns 400 RFC 7807 response on invalid query', () => {
    const { req, res } = makeReqRes({ page: '-1' });
    validateQuery(paginationQuerySchema)(req, res, mockNext);
    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0][0];
    expect(body.type).toMatch(/validation-error/);
    expect(body.fieldErrors).toHaveProperty('page');
    expect(mockNext).not.toHaveBeenCalled();
  });
});
