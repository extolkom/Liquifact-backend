
process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long-string-for-jest';
require('../../src/config').validate();

let mockInMemoryDb = [];
let mockCurrentTable = null;

jest.mock('../../src/db/knex', () => {
  const auditLogEvents = [];
  let queryWheres = {};
  let mockCurrentTable;

  const m = jest.fn((table) => {
    mockCurrentTable = table;
    queryWheres = {};
    return m;
  });

  m.where = jest.fn((field, value) => {
    if (typeof field === "string") {
      queryWheres[field] = value;
    }
    return m;
  });
  m.whereNotIn = jest.fn().mockReturnThis();
  m.whereNull = jest.fn().mockReturnThis();
  m.whereIn = jest.fn().mockReturnThis();
  m.leftJoin = jest.fn().mockReturnThis();
  m.orderBy = jest.fn().mockReturnThis();
  m.limit = jest.fn().mockReturnThis();
  m.offset = jest.fn().mockReturnThis();
  m.select = jest.fn().mockReturnThis();
  m.insert = jest.fn((data) => {
    const rows = Array.isArray(data) ? data : [data];

    const inserted = rows.map((r) => ({
      id: Math.random().toString(),
      created_at: new Date().toISOString(),
      ...r,
    }));

    auditLogEvents.push(...inserted);

    if (mockCurrentTable === "audit_log_events") {
      mockInMemoryDb.push(...inserted);
    }

    return Promise.resolve(inserted);
  });
  });
  m.update = jest.fn().mockReturnThis();
  m.del = jest.fn(() => {
    auditLogEvents.length = 0;
    return Promise.resolve(1);
  });
  m.first = jest.fn().mockResolvedValue({ id: 'test', kyc_status: 'approved' });
  m.returning = jest.fn().mockReturnThis();
  m.delete = jest.fn(() => {
    auditLogEvents.length = 0;
    return Promise.resolve(1);
  });
  m.andWhere = jest.fn().mockReturnThis();
  m.orWhere = jest.fn().mockReturnThis();
  m.count = jest.fn().mockResolvedValue([{ count: 25 }]);
  m.raw = jest.fn();
  m.then = jest.fn((onFulfilled) => {
    if (mockCurrentTable === "audit_log_events") {
      return Promise.resolve(mockInMemoryDb).then(onFulfilled);
    }
    return Promise.resolve([]).then(onFulfilled);
  });

  m.offset = jest.fn(() => {
    let results = [...auditLogEvents];

    if (queryWheres.target_id) {
      results = results.filter((r) => r.target_id === queryWheres.target_id);
    }

    if (queryWheres.target_type) {
      results = results.filter((r) => r.target_type === queryWheres.target_type);
    }

    if (queryWheres.actor_id) {
      results = results.filter((r) => r.actor_id === queryWheres.actor_id);
    }

    if (queryWheres.action) {
      results = results.filter((r) => r.action === queryWheres.action);
    }

    results.reverse();
    return Promise.resolve(results);
  });
  return m;
}, { virtual: true });

jest.mock('@stellar/stellar-sdk', () => ({
  nativeToScVal: jest.fn(),
  Address: {
    fromString: jest.fn(() => ({
      toScVal: jest.fn(),
    })),
  },
  Keypair: {
    fromSecret: jest.fn(() => ({
      publicKey: jest.fn(() => 'mock-public-key'),
      sign: jest.fn(),
    })),
  },
}), { virtual: true });

jest.mock('@stellar/stellar-sdk/rpc', () => ({
  Server: jest.fn().mockImplementation(() => ({
    getTransaction: jest.fn(),
    sendTransaction: jest.fn(),
    simulateTransaction: jest.fn(),
  })),
}), { virtual: true });

