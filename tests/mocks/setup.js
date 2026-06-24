
process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long-string-for-jest';
require('../../src/config').validate();

let mockInMemoryDb = [];
let mockCurrentTable = null;

jest.mock('../../src/db/knex', () => {
  const m = jest.fn((table) => {
    mockCurrentTable = table;
    return m;
  });
  m.where = jest.fn().mockReturnThis();
  m.whereNotIn = jest.fn().mockReturnThis();
  m.whereNull = jest.fn().mockReturnThis();
  m.whereIn = jest.fn().mockReturnThis();
  m.leftJoin = jest.fn().mockReturnThis();
  m.orderBy = jest.fn().mockReturnThis();
  m.limit = jest.fn().mockReturnThis();
  m.offset = jest.fn().mockReturnThis();
  m.select = jest.fn().mockReturnThis();
  m.insert = jest.fn((row) => {
    const rows = Array.isArray(row) ? row : [row];
    const inserted = rows.map(r => ({ id: Math.random().toString(), created_at: new Date().toISOString(), ...r }));
    if (mockCurrentTable === 'audit_log_events') {
      mockInMemoryDb.push(...inserted);
    }
    return Promise.resolve(inserted);
  });
  m.update = jest.fn().mockReturnThis();
  m.del = jest.fn().mockResolvedValue(1);
  m.first = jest.fn().mockResolvedValue({ id: 'test', kyc_status: 'approved' });
  m.returning = jest.fn().mockReturnThis();
  m.delete = jest.fn().mockResolvedValue(1);
  m.andWhere = jest.fn().mockReturnThis();
  m.orWhere = jest.fn().mockReturnThis();
  m.count = jest.fn().mockResolvedValue([{ count: 25 }]);
  m.raw = jest.fn();
  m.then = jest.fn((onFulfilled) => {
    if (mockCurrentTable === 'audit_log_events') {
      return Promise.resolve(mockInMemoryDb).then(onFulfilled);
    }
    return Promise.resolve([]).then(onFulfilled);
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

