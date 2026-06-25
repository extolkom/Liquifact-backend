
jest.mock('../../src/db/knex', () => {
  // Stateful in-memory store — all state must live inside the factory.
  const tables = {};
  function getRows(name) {
    if (!tables[name]) tables[name] = [];
    return tables[name];
  }

  function makeBuilder(tableName) {
    const colFilters = {};
    let _limit = null;
    let _offset = 0;

    const b = {
      where: jest.fn((col, val) => { colFilters[col] = val; return b; }),
      whereNotIn: jest.fn(() => b),
      whereNull: jest.fn(() => b),
      whereIn: jest.fn(() => b),
      whereRaw: jest.fn(() => b),
      leftJoin: jest.fn(() => b),
      orderBy: jest.fn(() => b),
      select: jest.fn(() => b),
      returning: jest.fn(() => b),
      andWhere: jest.fn(() => b),
      orWhere: jest.fn(() => b),
      limit: jest.fn((n) => { _limit = n; return b; }),
      offset: jest.fn((n) => { _offset = n; return b; }),

      insert: jest.fn((record) => {
        const row = { id: `mock-${Date.now()}-${Math.floor(Math.random() * 1e9)}`, created_at: new Date(), ...record };
        getRows(tableName).push(row);
        return Promise.resolve([row]);
      }),

      del: jest.fn(() => { tables[tableName] = []; return Promise.resolve(1); }),
      delete: jest.fn(() => { tables[tableName] = []; return Promise.resolve(1); }),
      update: jest.fn(() => Promise.resolve(1)),
      first: jest.fn(() => Promise.resolve({ id: 'test', kyc_status: 'approved' })),
      count: jest.fn(() => Promise.resolve([{ count: 25 }])),

      then: jest.fn((resolve, reject) => {
        try {
          let rows = [...getRows(tableName)];
          for (const [col, val] of Object.entries(colFilters)) {
            rows = rows.filter((r) => r[col] === val);
          }
          rows.sort((a, b2) => new Date(b2.created_at) - new Date(a.created_at));
          if (_offset) rows = rows.slice(_offset);
          if (_limit !== null) rows = rows.slice(0, _limit);
          return resolve(rows);
        } catch (e) {
          if (reject) return reject(e);
        }
      }),
    };

    return b;
  }

  const m = jest.fn((tableName) => makeBuilder(tableName));
  m.raw = jest.fn().mockResolvedValue();
  return m;
}, { virtual: true });
