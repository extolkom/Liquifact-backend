'use strict';

/**
 * @fileoverview API tests for the invoice audit trail endpoints.
 * Covers: trail retrieval, streaming CSV export with formula-injection escaping,
 * pagination, authz rejection, tenant isolation, and state-transition history.
 */

const { Readable } = require('stream');

jest.mock('../src/db/knex');
jest.mock('../src/middleware/apiKeyAuth', () => ({
  authenticateApiKey: jest.fn(() => jest.fn((req, res, next) => {
    req.apiClient = { clientId: 'api-client-1' };
    next();
  })),
  API_KEY_HEADER: 'x-api-key',
  timingSafeStringEqual: (a, b) => a === b,
}));

// ── Mock the streaming helpers so CSV export tests don't need a real DB ───────
// We expose setMockRows() so each test can control what the stream emits.
let mockRows = [];
const setMockRows = (rows) => { mockRows = rows; };

jest.mock('../src/services/auditLogStore', () => {
  const { Readable, Transform } = require('stream');
  const original = jest.requireActual('../src/services/auditLogStore');
  return {
    ...original,
    streamAuditEvents: jest.fn(() => Readable.from(mockRows, { objectMode: true })),
    appendAuditEvent: jest.fn().mockResolvedValue(undefined),
  };
});

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const {
  createAuditLog,
  clearAuditLogs,
  getAuditLogs,
} = require('../src/services/auditLog');
const { executeTransition } = require('../src/services/invoiceStateMachine');
const auditTrailRouter = require('../src/routes/auditTrail');

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const TENANT_A = 'tenant-alpha';
const TENANT_B = 'tenant-beta';

/** Build a signed JWT for a given tenantId */
function makeToken(tenantId = TENANT_A) {
  return jwt.sign({ sub: 'admin-1', tenantId }, JWT_SECRET, { expiresIn: '1h' });
}

/** Build a minimal Express app mounting the audit trail router */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/audit', auditTrailRouter);
  app.use((err, req, res, _next) => {
    res.status(err.status || 500).json({ error: err.detail || err.message || 'error' });
  });
  return app;
}

/** Seed an audit log entry for a given invoiceId and optional tenantId */
function seedLog(invoiceId, tenantId = TENANT_A, overrides = {}) {
  return createAuditLog({
    actor: 'admin-1',
    action: 'UPDATE',
    resourceType: 'invoice',
    resourceId: invoiceId,
    statusCode: 200,
    metadata: { tenantId, ...overrides.metadata },
    ...overrides,
  });
}

describe('GET /api/admin/audit/invoices/:invoiceId', () => {
  let app;

  beforeEach(() => {
    clearAuditLogs();
    app = buildApp();
  });

  it('returns 401 when no auth is provided', async () => {
    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-001')
      .set('x-tenant-id', TENANT_A);
    expect(res.status).toBe(401);
  });

  it('returns 400 when tenant context is missing', async () => {
    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-001')
      .set('Authorization', `Bearer ${makeToken()}`);
    // extractTenant rejects with 400 when no tenant header and no JWT claim
    // Our token includes tenantId so this should pass — test without tenantId in token
    const tokenNoTenant = jwt.sign({ sub: 'admin-1' }, JWT_SECRET, { expiresIn: '1h' });
    const res2 = await request(app)
      .get('/api/admin/audit/invoices/inv-001')
      .set('Authorization', `Bearer ${tokenNoTenant}`);
    expect(res2.status).toBe(400);
  });

  it('returns empty data array when no logs exist for invoice', async () => {
    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-none')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT_A);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.total).toBe(0);
  });

  it('returns audit trail for a specific invoice', async () => {
    seedLog('inv-001');
    seedLog('inv-001');
    seedLog('inv-002'); // different invoice — should not appear

    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-001')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT_A);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta.invoiceId).toBe('inv-001');
    expect(res.body.meta.total).toBe(2);
    res.body.data.forEach((entry) => expect(entry.resourceId).toBe('inv-001'));
  });

  it('enforces tenant isolation — does not return other tenant logs', async () => {
    seedLog('inv-001', TENANT_A);
    seedLog('inv-001', TENANT_B); // different tenant

    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-001')
      .set('Authorization', `Bearer ${makeToken(TENANT_A)}`)
      .set('x-tenant-id', TENANT_A);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta.total).toBe(1);
  });

  it('supports pagination via limit and offset', async () => {
    for (let i = 0; i < 5; i++) seedLog('inv-page');

    const page1 = await request(app)
      .get('/api/admin/audit/invoices/inv-page?limit=2&offset=0')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT_A);

    const page2 = await request(app)
      .get('/api/admin/audit/invoices/inv-page?limit=2&offset=2')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT_A);

    expect(page1.status).toBe(200);
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.meta.limit).toBe(2);
    expect(page1.body.meta.offset).toBe(0);

    expect(page2.status).toBe(200);
    expect(page2.body.data).toHaveLength(2);
    expect(page2.body.meta.offset).toBe(2);

    // IDs should be different across pages
    const ids1 = page1.body.data.map((e) => e.id);
    const ids2 = page2.body.data.map((e) => e.id);
    expect(ids1.some((id) => ids2.includes(id))).toBe(false);
  });

  it('clamps limit to MAX_LIMIT (500)', async () => {
    seedLog('inv-clamp');
    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-clamp?limit=9999')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT_A);
    expect(res.status).toBe(200);
    expect(res.body.meta.limit).toBe(500);
  });

  it('returns 400 for an empty invoiceId', async () => {
    // Express won't match empty segment — test a very long id instead
    const longId = 'x'.repeat(129);
    const res = await request(app)
      .get(`/api/admin/audit/invoices/${longId}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT_A);
    expect(res.status).toBe(400);
  });

  it('accepts x-api-key auth', async () => {
    seedLog('inv-apikey');
    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-apikey')
      .set('x-api-key', 'any-key')
      .set('x-tenant-id', TENANT_A);
    expect(res.status).toBe(200);
  });
});

describe('GET /api/admin/audit/invoices/:invoiceId/transitions', () => {
  let app;

  beforeEach(() => {
    clearAuditLogs();
    app = buildApp();
  });

  it('returns 401 without auth', async () => {
    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-001/transitions')
      .set('x-tenant-id', TENANT_A);
    expect(res.status).toBe(401);
  });

  it('returns empty array when no transitions exist', async () => {
    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-notrans/transitions')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT_A);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('returns state-transition history for an invoice', async () => {
    // Seed a STATE_TRANSITION log directly
    createAuditLog({
      actor: 'admin-1',
      action: 'STATE_TRANSITION',
      resourceType: 'invoice',
      resourceId: 'inv-trans',
      before: { state: 'pending' },
      after: { state: 'approved' },
      metadata: { tenantId: TENANT_A },
    });

    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-trans/transitions')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT_A);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const t = res.body.data[0];
    expect(t.fromState).toBe('pending');
    expect(t.toState).toBe('approved');
    expect(t.actor).toBe('admin-1');
  });

  it('enforces tenant isolation on transitions', async () => {
    createAuditLog({
      actor: 'admin-1',
      action: 'STATE_TRANSITION',
      resourceType: 'invoice',
      resourceId: 'inv-iso',
      before: { state: 'pending' },
      after: { state: 'approved' },
      metadata: { tenantId: TENANT_B }, // different tenant
    });

    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-iso/transitions')
      .set('Authorization', `Bearer ${makeToken(TENANT_A)}`)
      .set('x-tenant-id', TENANT_A);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });
});

describe('GET /api/admin/audit/invoices/:invoiceId/export', () => {
  let app;

  beforeEach(() => {
    clearAuditLogs();
    app = buildApp();
  });

  it('returns 401 without auth', async () => {
    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-001/export')
      .set('x-tenant-id', TENANT_A);
    expect(res.status).toBe(401);
  });

  it('exports JSON by default', async () => {
    seedLog('inv-export');
    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-export/export')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT_A);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const parsed = JSON.parse(res.text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].resourceId).toBe('inv-export');
  });

  it('exports CSV with correct headers', async () => {
    seedLog('inv-csv');
    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-csv/export?format=csv')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT_A);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    const lines = res.text.split('\n');
    expect(lines[0]).toBe('id,timestamp,actor,action,resourceType,resourceId,statusCode,ipAddress,userAgent');
    expect(lines.length).toBeGreaterThan(1);
  });

  it('CSV escapes commas in field values', async () => {
    createAuditLog({
      actor: 'admin,with,commas',
      action: 'UPDATE',
      resourceType: 'invoice',
      resourceId: 'inv-escape',
      metadata: { tenantId: TENANT_A },
    });

    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-escape/export?format=csv')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT_A);

    expect(res.status).toBe(200);
    expect(res.text).toContain('"admin,with,commas"');
  });

  it('CSV escapes double-quotes in field values', async () => {
    createAuditLog({
      actor: 'admin"quoted"',
      action: 'UPDATE',
      resourceType: 'invoice',
      resourceId: 'inv-quote',
      metadata: { tenantId: TENANT_A },
    });

    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-quote/export?format=csv')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT_A);

    expect(res.status).toBe(200);
    // Double-quote escaping: " → ""
    expect(res.text).toContain('"admin""quoted"""');
  });

  it('CSV returns only header row when no logs exist', async () => {
    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-empty/export?format=csv')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT_A);

    expect(res.status).toBe(200);
    expect(res.text.trim()).toBe('id,timestamp,actor,action,resourceType,resourceId,statusCode,ipAddress,userAgent');
  });

  it('does not expose sensitive fields in export', async () => {
    createAuditLog({
      actor: 'admin-1',
      action: 'UPDATE',
      resourceType: 'invoice',
      resourceId: 'inv-redact',
      before: { apiKey: 'super-secret-before', amount: 100 },
      after: { apiKey: 'super-secret-after', amount: 200 },
      metadata: { tenantId: TENANT_A },
    });

    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-redact/export')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT_A);

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('super-secret-before');
    expect(res.text).not.toContain('super-secret-after');
    expect(res.text).toContain('***REDACTED***');
  });

  it('enforces tenant isolation on export', async () => {
    seedLog('inv-tenant-export', TENANT_B);

    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-tenant-export/export')
      .set('Authorization', `Bearer ${makeToken(TENANT_A)}`)
      .set('x-tenant-id', TENANT_A);

    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.text);
    expect(parsed).toHaveLength(0);
  });

  it('respects limit param on export', async () => {
    for (let i = 0; i < 10; i++) seedLog('inv-limit-export');

    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-limit-export/export?limit=3')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT_A);

    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.text);
    expect(parsed).toHaveLength(3);
  });
});

// ── Streaming CSV export (new behaviour) ─────────────────────────────────────

/** Minimal DB row as returned from audit_log_events. */
function makeDbRow(overrides = {}) {
  return {
    id: 1,
    created_at: new Date('2024-01-15T10:00:00Z'),
    actor_id: 'admin-1',
    action: 'UPDATE',
    target_type: 'invoice',
    target_id: 'inv-stream',
    status_code: 200,
    ip_address: '127.0.0.1',
    user_agent: 'jest',
    ...overrides,
  };
}

describe('GET /api/admin/audit/invoices/:invoiceId/export — streaming CSV', () => {
  let app;

  beforeEach(() => {
    setMockRows([]);
    clearAuditLogs();
    app = buildApp();
  });

  it('returns 401 without auth', async () => {
    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-001/export?format=csv')
      .set('x-tenant-id', TENANT_A);
    expect(res.status).toBe(401);
  });

  it('returns 400 for an invalid (too-long) invoiceId', async () => {
    const longId = 'x'.repeat(129);
    const res = await request(app)
      .get(`/api/admin/audit/invoices/${longId}/export?format=csv`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT_A);
    expect(res.status).toBe(400);
  });

  it('returns text/csv content-type and attachment disposition', async () => {
    setMockRows([makeDbRow()]);
    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-stream/export?format=csv')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT_A);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.headers['content-disposition']).toMatch(/inv-stream/);
  });

  it('emits header-only row when audit trail is empty', async () => {
    setMockRows([]); // no rows
    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-empty/export?format=csv')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT_A);

    expect(res.status).toBe(200);
    expect(res.text.trim()).toBe(
      'id,timestamp,actor,action,resourceType,resourceId,statusCode,ipAddress,userAgent'
    );
  });

  it('streams header + one data row for a single event', async () => {
    setMockRows([makeDbRow()]);
    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-stream/export?format=csv')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT_A);

    const lines = res.text.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      'id,timestamp,actor,action,resourceType,resourceId,statusCode,ipAddress,userAgent'
    );
    expect(lines[1]).toContain('admin-1');
    expect(lines[1]).toContain('inv-stream');
  });

  it('streams 500 rows without buffering (large trail)', async () => {
    const rows = Array.from({ length: 500 }, (_, i) =>
      makeDbRow({ id: i + 1, target_id: `inv-${i}` })
    );
    setMockRows(rows);
    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-large/export?format=csv')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT_A);

    const lines = res.text.split('\n').filter(Boolean);
    expect(lines).toHaveLength(501); // 1 header + 500 data rows
  });

  // Formula-injection safety ────────────────────────────────────────────────

  it('escapes = prefix in actor field (formula injection prevention)', async () => {
    setMockRows([makeDbRow({ actor_id: '=SUM(A1)' })]);
    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-inject/export?format=csv')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT_A);

    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(/(?<!['])=SUM/); // bare = must not appear
    expect(res.text).toContain("'=SUM(A1)");
  });

  it('escapes + prefix in actor field', async () => {
    setMockRows([makeDbRow({ actor_id: '+malicious' })]);
    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-inject/export?format=csv')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT_A);

    expect(res.text).toContain("'+malicious");
  });

  it('escapes - prefix in actor field', async () => {
    setMockRows([makeDbRow({ actor_id: '-2+3' })]);
    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-inject/export?format=csv')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT_A);

    expect(res.text).toContain("'-2+3");
  });

  it('escapes @ prefix in actor field', async () => {
    setMockRows([makeDbRow({ actor_id: '@SUM(1)' })]);
    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-inject/export?format=csv')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT_A);

    expect(res.text).toContain("'@SUM(1)");
  });

  it('wraps comma-containing fields in double-quotes', async () => {
    setMockRows([makeDbRow({ actor_id: 'alice,bob' })]);
    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-comma/export?format=csv')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT_A);

    expect(res.text).toContain('"alice,bob"');
  });

  it('doubles embedded double-quotes per RFC 4180', async () => {
    setMockRows([makeDbRow({ actor_id: 'admin"quoted"' })]);
    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-quote/export?format=csv')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT_A);

    expect(res.text).toContain('"admin""quoted"""');
  });

  // Tenant isolation ────────────────────────────────────────────────────────

  it('passes tenantId to streamAuditEvents for DB-level isolation', async () => {
    const { streamAuditEvents } = require('../src/services/auditLogStore');
    setMockRows([]);
    await request(app)
      .get('/api/admin/audit/invoices/inv-iso/export?format=csv')
      .set('Authorization', `Bearer ${makeToken(TENANT_A)}`)
      .set('x-tenant-id', TENANT_A);

    expect(streamAuditEvents).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_A }),
    );
  });
});

describe('Retention policy and legal-hold mutation audit', () => {
  const db = require('../src/db/knex');
  const { appendAuditEvent, REDACTED } = require('../src/services/auditLogStore');
  const { emitRetentionAuditSafely } = require('../src/middleware/auditLog');
  const retentionRouter = require('../src/routes/retention');

  const POLICY_ID = '11111111-1111-4111-8111-111111111111';
  const HOLD_ID = '22222222-2222-4222-8222-222222222222';
  const INVOICE_ID = '33333333-3333-4333-8333-333333333333';

  let retentionApp;

  function makeQueryChain(handlers = {}) {
    const query = {
      where: jest.fn(function where(arg) {
        if (typeof arg === 'function') {
          arg.call(query);
        }
        return query;
      }),
      whereNull: jest.fn(function whereNull() { return query; }),
      orWhere: jest.fn(function orWhere() { return query; }),
      leftJoin: jest.fn(function leftJoin() { return query; }),
      select: jest.fn(function select() { return query; }),
      orderBy: jest.fn(function orderBy() { return query; }),
      insert: jest.fn(function insert() { return query; }),
      update: jest.fn(function update() { return query; }),
      returning: jest.fn(function returning() {
        return Promise.resolve(
          typeof handlers.returning === 'function' ? handlers.returning() : handlers.returning || [],
        );
      }),
      first: jest.fn(function first() {
        return Promise.resolve(
          typeof handlers.first === 'function' ? handlers.first() : handlers.first ?? null,
        );
      }),
    };
    return query;
  }

  function buildRetentionApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { sub: 'admin-retention-1', tenantId: TENANT_A };
      req.tenantId = TENANT_A;
      req.userId = 'admin-retention-1';
      next();
    });
    app.use('/api/retention', retentionRouter);
    app.use((err, req, res, _next) => {
      res.status(err.status || 500).json({ error: err.detail || err.message || 'error' });
    });
    return app;
  }

  beforeEach(() => {
    appendAuditEvent.mockClear();
    appendAuditEvent.mockResolvedValue(undefined);
    retentionApp = buildRetentionApp();
  });

  it('audits retention policy create with actor, tenant, target, and after snapshot', async () => {
    const createdPolicy = {
      id: POLICY_ID,
      tenant_id: TENANT_A,
      name: '5-Year Retention',
      description: 'Purge after five years',
      retention_days: 1825,
      pii_fields: ['customer_name', 'customer_email'],
      is_active: true,
    };

    db.mockImplementation((table) => {
      if (table === 'retention_policies') {
        return makeQueryChain({
          first: null,
          returning: [createdPolicy],
        });
      }
      return makeQueryChain();
    });

    const res = await request(retentionApp)
      .post('/api/retention/policies')
      .set('Authorization', `Bearer ${makeToken(TENANT_A)}`)
      .set('x-tenant-id', TENANT_A)
      .send({
        name: '5-Year Retention',
        description: 'Purge after five years',
        retentionDays: 1825,
        piiFields: ['customer_name', 'customer_email'],
        isActive: true,
        apiKey: 'must-be-redacted',
      });

    expect(res.status).toBe(201);
    expect(appendAuditEvent).toHaveBeenCalledTimes(1);
    expect(appendAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'retention_mutation',
        action: 'retention.policy.create',
        actorType: 'user',
        actorId: 'admin-1',
        targetType: 'retention_policy',
        targetId: POLICY_ID,
        statusCode: 201,
        metadata: expect.objectContaining({
          tenantId: TENANT_A,
          before: null,
          after: expect.objectContaining({ id: POLICY_ID, name: '5-Year Retention' }),
        }),
      }),
    );
  });

  it('audits retention policy update with before and after snapshots', async () => {
    const existingPolicy = {
      id: POLICY_ID,
      tenant_id: TENANT_A,
      name: 'Old Policy',
      description: 'Before',
      retention_days: 365,
      pii_fields: ['customer_name'],
      is_active: true,
    };
    const updatedPolicy = {
      ...existingPolicy,
      name: 'Updated Policy',
      retention_days: 730,
    };

    db.mockImplementation((table) => {
      if (table === 'retention_policies') {
        return makeQueryChain({
          first: existingPolicy,
          returning: [updatedPolicy],
        });
      }
      return makeQueryChain();
    });

    const res = await request(retentionApp)
      .put(`/api/retention/policies/${POLICY_ID}`)
      .set('Authorization', `Bearer ${makeToken(TENANT_A)}`)
      .set('x-tenant-id', TENANT_A)
      .send({ name: 'Updated Policy', retentionDays: 730 });

    expect(res.status).toBe(200);
    expect(appendAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'retention.policy.update',
        targetId: POLICY_ID,
        metadata: expect.objectContaining({
          tenantId: TENANT_A,
          before: expect.objectContaining({ name: 'Old Policy' }),
          after: expect.objectContaining({ name: 'Updated Policy', retention_days: 730 }),
        }),
      }),
    );
  });

  it('audits legal-hold create and release with full hold trace', async () => {
    const activeHold = {
      id: HOLD_ID,
      tenant_id: TENANT_A,
      invoice_id: INVOICE_ID,
      hold_reason: 'Regulatory review',
      hold_type: 'regulatory',
      status: 'active',
      expires_at: null,
      placed_by: 'admin-retention-1',
      released_at: null,
      release_reason: null,
    };
    const releasedHold = {
      ...activeHold,
      status: 'released',
      released_at: new Date().toISOString(),
      release_reason: 'Investigation closed',
    };

    let legalHoldPhase = 'create';

    db.mockImplementation((table) => {
      if (table === 'invoices') {
        return makeQueryChain({
          first: { id: INVOICE_ID, tenant_id: TENANT_A, invoice_number: 'INV-001' },
        });
      }
      if (table === 'legal_holds') {
        if (legalHoldPhase === 'create') {
          return makeQueryChain({
            first: null,
            returning: [activeHold],
          });
        }
        return makeQueryChain({
          first: activeHold,
          returning: [releasedHold],
        });
      }
      return makeQueryChain();
    });

    const createRes = await request(retentionApp)
      .post('/api/retention/legal-holds')
      .set('Authorization', `Bearer ${makeToken(TENANT_A)}`)
      .set('x-tenant-id', TENANT_A)
      .send({
        invoiceId: INVOICE_ID,
        holdReason: 'Regulatory review',
        holdType: 'regulatory',
      });

    expect(createRes.status).toBe(201);
    expect(appendAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'retention.legal_hold.create',
        targetType: 'legal_hold',
        targetId: HOLD_ID,
        metadata: expect.objectContaining({
          tenantId: TENANT_A,
          invoiceId: INVOICE_ID,
          after: expect.objectContaining({ status: 'active' }),
        }),
      }),
    );

    appendAuditEvent.mockClear();
    legalHoldPhase = 'release';

    const releaseRes = await request(retentionApp)
      .post(`/api/retention/legal-holds/${HOLD_ID}/release`)
      .set('Authorization', `Bearer ${makeToken(TENANT_A)}`)
      .set('x-tenant-id', TENANT_A)
      .send({ releaseReason: 'Investigation closed' });

    expect(releaseRes.status).toBe(200);
    expect(appendAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'retention.legal_hold.release',
        targetId: HOLD_ID,
        metadata: expect.objectContaining({
          tenantId: TENANT_A,
          invoiceId: INVOICE_ID,
          releaseReason: 'Investigation closed',
          before: expect.objectContaining({ status: 'active' }),
          after: expect.objectContaining({
            status: 'released',
            release_reason: 'Investigation closed',
          }),
        }),
      }),
    );
  });

  it('does not audit cross-tenant policy updates blocked by tenant scoping', async () => {
    db.mockImplementation((table) => {
      if (table === 'retention_policies') {
        return makeQueryChain({ first: null });
      }
      return makeQueryChain();
    });

    const res = await request(retentionApp)
      .put(`/api/retention/policies/${POLICY_ID}`)
      .set('Authorization', `Bearer ${makeToken(TENANT_A)}`)
      .set('x-tenant-id', TENANT_A)
      .send({ name: 'Should Not Apply' });

    expect(res.status).toBe(404);
    expect(appendAuditEvent).not.toHaveBeenCalled();
  });

  it('logs audit persistence failures without breaking the primary mutation', async () => {
    appendAuditEvent.mockRejectedValueOnce(new Error('audit store unavailable'));

    const req = {
      user: { sub: 'admin-retention-1' },
      tenantId: TENANT_A,
      headers: {},
      originalUrl: '/api/retention/policies',
      method: 'POST',
      ip: '127.0.0.1',
      get: () => 'jest-agent',
    };

    await expect(
      emitRetentionAuditSafely(req, 'retention.policy.create', {
        targetType: 'retention_policy',
        targetId: POLICY_ID,
        statusCode: 201,
        after: { id: POLICY_ID, apiKey: 'secret-key' },
        metadata: { tenantId: TENANT_A },
      }),
    ).resolves.toBeUndefined();

    expect(appendAuditEvent).toHaveBeenCalledTimes(1);
    const persistedMetadata = appendAuditEvent.mock.calls[0][0].metadata;
    expect(persistedMetadata.after.apiKey).toBe(REDACTED);
  });
});
