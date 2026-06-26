'use strict';

const requestId = require('../../src/middleware/requestId');
const { correlationIdMiddleware } = require('../../src/middleware/correlationId');

describe('Request ID Middleware', () => {
  let req;
  let res;
  let next;

  beforeEach(() => {
    req = {
      headers: {},
      header(name) {
        return this.headers[name.toLowerCase()];
      },
    };
    res = {
      setHeader: jest.fn(),
    };
    next = jest.fn();
  });

  it('should generate a new ID if none is present', () => {
    requestId(req, res, next);
    expect(req.id).toBeDefined();
    expect(typeof req.id).toBe('string');
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', req.id);
    expect(next).toHaveBeenCalled();
  });

  it('should attach a child logger scoped to the request id', () => {
    requestId(req, res, next);

    expect(req.log).toBeDefined();
    expect(req.log.bindings()).toMatchObject({ requestId: req.id });
  });

  it('should reuse an existing X-Request-Id header', () => {
    const existingId = 'test-id-123';
    req.headers['x-request-id'] = existingId;

    requestId(req, res, next);

    expect(req.id).toBe(existingId);
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', existingId);
    expect(next).toHaveBeenCalled();
  });

  it('should reuse an existing request-id header (case insensitive/alternate)', () => {
    const existingId = 'alt-id-456';
    req.headers['request-id'] = existingId;

    requestId(req, res, next);

    expect(req.id).toBe(existingId);
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', existingId);
    expect(next).toHaveBeenCalled();
  });

  it('should propagate the correlation id into the request-scoped logger', () => {
    requestId(req, res, next);
    req.headers['x-correlation-id'] = 'corr-123';

    correlationIdMiddleware(req, res, next);

    expect(req.log.bindings()).toMatchObject({ requestId: req.id, correlationId: 'corr-123' });
  });

  it('should keep request-scoped loggers isolated between requests', () => {
    const firstReq = { headers: {}, header(name) { return this.headers[name.toLowerCase()]; } };
    const secondReq = { headers: {}, header(name) { return this.headers[name.toLowerCase()]; } };
    const firstRes = { setHeader: jest.fn() };
    const secondRes = { setHeader: jest.fn() };

    requestId(firstReq, firstRes, jest.fn());
    requestId(secondReq, secondRes, jest.fn());

    expect(firstReq.log).not.toBe(secondReq.log);
    expect(firstReq.log.bindings().requestId).not.toBe(secondReq.log.bindings().requestId);
  });
});
