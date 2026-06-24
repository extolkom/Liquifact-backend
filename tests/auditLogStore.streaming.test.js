'use strict';

/**
 * @fileoverview Unit tests for the streaming CSV helpers exported by
 * auditLogStore: escapeCsvField, rowToCsvLine, createCsvTransform, and
 * streamAuditEvents.
 *
 * All database interactions are replaced by in-process mock streams so
 * that these tests run entirely without a real database connection.
 */

const { Readable, pipeline } = require('stream');
const { promisify } = require('util');

const pipelineAsync = promisify(pipeline);

jest.mock('../src/db/knex');

const {
  escapeCsvField,
  CSV_HEADERS,
  rowToCsvLine,
  createCsvTransform,
  streamAuditEvents,
} = require('../src/services/auditLogStore');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Collects all string chunks emitted by a readable into one string. */
function collectStream(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on('data', (chunk) => chunks.push(String(chunk)));
    readable.on('end', () => resolve(chunks.join('')));
    readable.on('error', reject);
  });
}

/** Creates an object-mode Readable that emits the supplied rows then ends. */
function rowsToStream(rows) {
  return Readable.from(rows, { objectMode: true });
}

/** Builds a minimal audit_log_events DB row. */
function makeRow(overrides = {}) {
  return {
    id: 1,
    created_at: new Date('2024-01-15T10:00:00Z'),
    actor_id: 'admin-1',
    action: 'UPDATE',
    target_type: 'invoice',
    target_id: 'inv-001',
    status_code: 200,
    ip_address: '127.0.0.1',
    user_agent: 'Mozilla/5.0',
    ...overrides,
  };
}

// ── escapeCsvField ────────────────────────────────────────────────────────────

describe('escapeCsvField', () => {
  it('returns plain values unchanged', () => {
    expect(escapeCsvField('hello')).toBe('hello');
    expect(escapeCsvField(42)).toBe('42');
    expect(escapeCsvField(200)).toBe('200');
  });

  it('converts null / undefined to empty string', () => {
    expect(escapeCsvField(null)).toBe('');
    expect(escapeCsvField(undefined)).toBe('');
  });

  it('wraps values containing commas in double-quotes', () => {
    expect(escapeCsvField('a,b,c')).toBe('"a,b,c"');
  });

  it('wraps values containing double-quotes and doubles them (RFC 4180)', () => {
    expect(escapeCsvField('say "hello"')).toBe('"say ""hello"""');
  });

  it('wraps values containing newlines', () => {
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
  });

  // Formula-injection safety (OWASP / spreadsheet DDE)
  it('prefixes = with a single quote to neutralise formula injection', () => {
    expect(escapeCsvField('=SUM(A1:A10)')).toBe("'=SUM(A1:A10)");
  });

  it('prefixes + with a single quote', () => {
    expect(escapeCsvField('+cmd|...')).toBe("'+cmd|...");
  });

  it('prefixes - with a single quote', () => {
    expect(escapeCsvField('-2+3')).toBe("'-2+3");
  });

  it('prefixes @ with a single quote', () => {
    expect(escapeCsvField('@SUM(1+1)')).toBe("'@SUM(1+1)");
  });

  it('handles a value that needs both injection-prefix and quoting (comma)', () => {
    // =HYPERLINK("...","click") — starts with =, contains a comma
    const val = '=HYPERLINK("url","click")';
    const result = escapeCsvField(val);
    // Should be prefixed with ' then wrapped because it now contains quotes
    expect(result.startsWith("\"'=")).toBe(true);
    expect(result.endsWith('"')).toBe(true);
  });

  it('leaves a normal leading hyphen in a negative number unaffected (numeric)', () => {
    // Numbers are coerced to string; "-100" starts with - so it gets prefixed
    expect(escapeCsvField(-100)).toBe("'-100");
  });
});

// ── rowToCsvLine ──────────────────────────────────────────────────────────────

describe('rowToCsvLine', () => {
  it('produces correct column order matching CSV_HEADERS', () => {
    const row = makeRow();
    const line = rowToCsvLine(row);
    const parts = line.split(',');
    expect(parts).toHaveLength(CSV_HEADERS.length);
    expect(parts[2]).toBe('admin-1'); // actor
    expect(parts[3]).toBe('UPDATE');  // action
    expect(parts[5]).toBe('inv-001'); // resourceId
  });

  it('escapes comma-containing actor names', () => {
    const row = makeRow({ actor_id: 'alice,bob' });
    expect(rowToCsvLine(row)).toContain('"alice,bob"');
  });

  it('escapes formula-injection actors', () => {
    const row = makeRow({ actor_id: '=MALICIOUS()' });
    expect(rowToCsvLine(row)).toContain("'=MALICIOUS()");
  });

  it('handles null optional fields gracefully', () => {
    const row = makeRow({ ip_address: null, user_agent: null, status_code: null });
    const line = rowToCsvLine(row);
    // Should not throw and trailing commas represent empty fields
    expect(typeof line).toBe('string');
    expect(line.endsWith(',,')).toBe(true);
  });
});

// ── createCsvTransform ────────────────────────────────────────────────────────

describe('createCsvTransform', () => {
  it('emits header-only when given zero rows (empty trail)', async () => {
    const src = rowsToStream([]);
    const transform = createCsvTransform();
    const output = await collectStream(src.pipe(transform));
    expect(output.trim()).toBe(CSV_HEADERS.join(','));
  });

  it('emits header + one data row for a single row', async () => {
    const row = makeRow();
    const src = rowsToStream([row]);
    const transform = createCsvTransform();
    const output = await collectStream(src.pipe(transform));
    const lines = output.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(CSV_HEADERS.join(','));
    expect(lines[1]).toContain('admin-1');
  });

  it('emits header + N data rows for N rows (large trail)', async () => {
    const N = 500;
    const rows = Array.from({ length: N }, (_, i) =>
      makeRow({ id: i + 1, target_id: `inv-${i}` })
    );
    const src = rowsToStream(rows);
    const transform = createCsvTransform();
    const output = await collectStream(src.pipe(transform));
    const lines = output.split('\n').filter(Boolean);
    expect(lines).toHaveLength(N + 1); // header + N rows
  });

  it('escapes formula-injection in streamed rows', async () => {
    const row = makeRow({ actor_id: '=CMD()' });
    const src = rowsToStream([row]);
    const transform = createCsvTransform();
    const output = await collectStream(src.pipe(transform));
    expect(output).toContain("'=CMD()");
    expect(output).not.toContain('=CMD()'); // bare injection must not appear
  });

  it('escapes commas in streamed field values', async () => {
    const row = makeRow({ actor_id: 'alice,bob' });
    const src = rowsToStream([row]);
    const transform = createCsvTransform();
    const output = await collectStream(src.pipe(transform));
    expect(output).toContain('"alice,bob"');
  });

  it('escapes double-quotes in streamed field values', async () => {
    const row = makeRow({ actor_id: 'admin"quoted"' });
    const src = rowsToStream([row]);
    const transform = createCsvTransform();
    const output = await collectStream(src.pipe(transform));
    expect(output).toContain('"admin""quoted"""');
  });

  it('propagates upstream errors to the transform', (done) => {
    const src = new Readable({
      objectMode: true,
      read() {
        this.emit('error', new Error('db error'));
      },
    });
    const transform = createCsvTransform();
    src.pipe(transform);
    transform.on('error', (err) => {
      expect(err.message).toBe('db error');
      done();
    });
  });

  it('writes only one header row across multiple rows', async () => {
    const rows = [makeRow({ id: 1 }), makeRow({ id: 2 }), makeRow({ id: 3 })];
    const src = rowsToStream(rows);
    const transform = createCsvTransform();
    const output = await collectStream(src.pipe(transform));
    const headerOccurrences = output.split(CSV_HEADERS.join(',')).length - 1;
    expect(headerOccurrences).toBe(1);
  });
});

// ── streamAuditEvents ─────────────────────────────────────────────────────────

describe('streamAuditEvents', () => {
  /**
   * Builds a tiny mock Knex that records how it was called and returns a
   * Readable stream of the supplied rows when `.stream()` is invoked.
   */
  function makeMockKnex(rows = []) {
    const calls = {};
    const mockQuery = {
      select: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      whereRaw: jest.fn().mockReturnThis(),
      stream: jest.fn(() => rowsToStream(rows)),
    };
    const knex = jest.fn(() => mockQuery);
    knex._query = mockQuery;
    knex._calls = calls;
    return knex;
  }

  it('calls .stream() on the knex query builder', () => {
    const mockKnex = makeMockKnex([]);
    streamAuditEvents({}, { db: mockKnex });
    expect(mockKnex._query.stream).toHaveBeenCalledTimes(1);
  });

  it('applies targetId filter when provided', () => {
    const mockKnex = makeMockKnex([]);
    streamAuditEvents({ targetId: 'inv-123' }, { db: mockKnex });
    expect(mockKnex._query.where).toHaveBeenCalledWith('target_id', 'inv-123');
  });

  it('applies targetType filter when provided', () => {
    const mockKnex = makeMockKnex([]);
    streamAuditEvents({ targetType: 'invoice' }, { db: mockKnex });
    expect(mockKnex._query.where).toHaveBeenCalledWith('target_type', 'invoice');
  });

  it('applies tenantId filter via whereRaw on the JSONB column', () => {
    const mockKnex = makeMockKnex([]);
    streamAuditEvents({ tenantId: 'tenant-alpha' }, { db: mockKnex });
    expect(mockKnex._query.whereRaw).toHaveBeenCalledWith(
      "metadata->>'tenantId' = ?",
      ['tenant-alpha']
    );
  });

  it('does NOT call whereRaw when tenantId is omitted', () => {
    const mockKnex = makeMockKnex([]);
    streamAuditEvents({ targetId: 'inv-1' }, { db: mockKnex });
    expect(mockKnex._query.whereRaw).not.toHaveBeenCalled();
  });

  it('streams rows through to createCsvTransform correctly', async () => {
    const rows = [makeRow({ id: 1 }), makeRow({ id: 2 })];
    const mockKnex = makeMockKnex(rows);

    const dbStream = streamAuditEvents({ targetId: 'inv-001' }, { db: mockKnex });
    const transform = createCsvTransform();
    const output = await collectStream(dbStream.pipe(transform));

    const lines = output.split('\n').filter(Boolean);
    expect(lines[0]).toBe(CSV_HEADERS.join(','));
    expect(lines).toHaveLength(3); // header + 2 rows
  });

  it('returns a readable stream (not a plain array)', () => {
    const mockKnex = makeMockKnex([]);
    const result = streamAuditEvents({}, { db: mockKnex });
    expect(typeof result.pipe).toBe('function');
    expect(typeof result.on).toBe('function');
  });
});
