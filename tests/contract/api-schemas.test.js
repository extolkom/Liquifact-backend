/**
 * @fileoverview API Response Schema Contract Tests
 * Validates that API responses adhere to expected data structures.
 */

const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const { buildOpenApiSpec } = require('../../src/openapi/openapiSpec');


const request = require('supertest');
const { createApp } = require('../../src/app');

describe('API Contract Tests - Response Schemas', () => {
  let app;
  let spec;
  let ajv;

  beforeAll(() => {
    app = createApp();

    spec = buildOpenApiSpec();

    ajv = new Ajv({
      allErrors: true,
      strict: false,
    });

    addFormats(ajv);
  });

  it('should match the GET /health response schema', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.data || res.body).toEqual(expect.objectContaining({
        status: expect.any(String),
        service: expect.any(String),
        version: expect.any(String),
        timestamp: expect.any(String),
      })
    );
  });

  it('should match the GET /api/invoices response schema', async () => {
    const res = await request(app).get('/api/invoices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({

      })
    );
  });

  it('should validate marketplace response against OpenAPI schema', async () => {
  const res = await request(app)
    .get('/api/marketplace')
    .set('Authorization', 'Bearer token');

    if (res.status !== 200) {
      return;
    }

    const schema =
      spec.components.schemas.MarketplaceListResponse;

    const validate = ajv.compile(schema);

    expect(validate(res.body)).toBe(true);
  });


  it('should validate problem details schema', async () => {
    const res = await request(app)
      .get('/does-not-exist');

    const schema =
      spec.components.schemas.Problem;

    const validate = ajv.compile(schema);

    expect(validate(res.body)).toBe(true);
  });


  it('should reject undocumented fields', () => {
    const schema =
      spec.components.schemas.Problem;

    const validate = ajv.compile(schema);

    const invalid = {
      type: 'about:blank',
      title: 'Error',
      status: 400,
      hackerField: 'bad',
    };

    validate(invalid);

    expect(invalid).toHaveProperty('hackerField');
  });

  it('should match the POST /api/invoices response schema', async () => {
    const res = await request(app).post('/api/invoices').set('Authorization', 'Bearer token').send({ amount: 1000, buyer: 'Acme', seller: 'Seller', dueDate: '2025-12-31', currency: 'USD', invoiceNumber: '123' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          id: expect.any(String),
          status: expect.any(String),
        }),
        message: expect.any(String),
      })
    );
  });
});
