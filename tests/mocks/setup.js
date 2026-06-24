
jest.mock('../../src/db/knex', () => {
  const auditLogEvents = [];
  let queryWheres = {};

  const m = jest.fn(() => {
    queryWheres = {};
    return m;
  });

  m.where = jest.fn((field, value) => {
    if (typeof field === 'string') {
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
  m.select = jest.fn().mockReturnThis();
  m.insert = jest.fn((data) => {
    auditLogEvents.push(data);
    return m;
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

  m.offset = jest.fn(() => {
    let results = [...auditLogEvents];
    if (queryWheres.target_id) {
      results = results.filter(r => r.target_id === queryWheres.target_id);
    }
    if (queryWheres.target_type) {
      results = results.filter(r => r.target_type === queryWheres.target_type);
    }
    if (queryWheres.actor_id) {
      results = results.filter(r => r.actor_id === queryWheres.actor_id);
    }
    if (queryWheres.action) {
      results = results.filter(r => r.action === queryWheres.action);
    }
    results.reverse();
    return Promise.resolve(results);
  });

  return m;
}, { virtual: true });
