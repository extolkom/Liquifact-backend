const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const { createApp } = require('../src/index');
const { parseBearerAuthorizationHeader, tokensMatch } = require('../src/middleware/auth');
const requestId = require('../src/middleware/requestId');
const {
  sanitizeRequestId,
  generateRequestId,
  resolveRequestIdFromHeaders,
  MAX_REQUEST_ID_LENGTH,
} = requestId;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_TOKEN = 'test-suite-token';

/**
 * Build an Authorization header value for security middleware tests.
 *
 * @param {string} token Token to embed after the Bearer scheme.
 * @returns {string}
 */
function buildBearerHeader(token) {
  return `Bearer ${token}`;
}

/**
 * Assert the stable structured error contract returned by middleware failures.
 *
 * @param {import('supertest').Response} response HTTP response object.
 * @param {{ code: string, message: string, retryable: boolean, retryHint: string }} expected Expected error fields.
 * @returns {void}
 */
function assertStructuredError(response, expected) {
  assert.equal(typeof response.body.error, 'object');
  assert.equal(response.body.error.code, expected.code);
  assert.equal(response.body.error.message, expected.message);
  assert.equal(response.body.error.retryable, expected.retryable);
  assert.equal(response.body.error.retry_hint, expected.retryHint);
  assert.match(response.body.error.correlation_id, /^req_[A-Za-z0-9]+$|^[A-Za-z0-9_-]{8,64}$/);
  assert.equal(response.headers['x-correlation-id'], response.body.error.correlation_id);
}

test('protected endpoint rejects requests without Authorization header', async () => {
  const app = createApp({ enableTestRoutes: true, securityToken: VALID_TOKEN });
  const response = await request(app).get('/__test__/auth');

  assert.equal(response.status, 401);
  assertStructuredError(response, {
    code: 'AUTHENTICATION_REQUIRED',
    message: 'Authentication is required for this endpoint.',
    retryable: false,
    retryHint: 'Provide a valid Bearer token and try again.',
  });
});

test('protected endpoint accepts requests with the configured Bearer token', async () => {
  const app = createApp({ enableTestRoutes: true, securityToken: VALID_TOKEN });
  const response = await request(app)
    .get('/__test__/auth')
    .set('Authorization', buildBearerHeader(VALID_TOKEN));

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true });
});

test('malformed Authorization headers fail safely', async (t) => {
  const app = createApp({ enableTestRoutes: true, securityToken: VALID_TOKEN });
  const malformedHeaders = [
    '',
    'Bearer',
    'Basic abc123',
    'Bearer token extra',
    'Bearer token,second',
  ];

  await Promise.all(
    malformedHeaders.map((headerValue) =>
      t.test(`header "${headerValue || '<empty>'}" is rejected`, async () => {
        const response = await request(app)
          .get('/__test__/auth')
          .set('Authorization', headerValue);

        assert.equal(response.status, 400);
        assertStructuredError(response, {
          code: 'VALIDATION_ERROR',
          message: 'Authorization header is malformed.',
          retryable: false,
          retryHint: 'Send a Bearer token in the Authorization header and try again.',
        });
      }),
    ),
  );
});

test('invalid or tampered tokens are rejected without leaking internals', async (t) => {
  const app = createApp({ enableTestRoutes: true, securityToken: VALID_TOKEN });
  const invalidTokens = ['garbage-token', `${VALID_TOKEN}-tampered`, 'BearerInsideToken'];

  await Promise.all(
    invalidTokens.map((token) =>
      t.test(`token "${token}" is rejected`, async () => {
        const response = await request(app)
          .get('/__test__/auth')
          .set('Authorization', buildBearerHeader(token));

        assert.equal(response.status, 401);
        assertStructuredError(response, {
          code: 'INVALID_TOKEN',
          message: 'The provided access token is invalid.',
          retryable: false,
          retryHint: 'Provide a valid Bearer token and try again.',
        });
        assert.equal(JSON.stringify(response.body).includes(VALID_TOKEN), false);
      }),
    ),
  );
});

test('malformed headers on public routes do not block public access', async () => {
  const app = createApp({ enableTestRoutes: true, securityToken: VALID_TOKEN });
  const response = await request(app)
    .get('/health')
    .set('Authorization', 'Basic should-not-matter');

  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'ok');
});

test('rate limiter allows initial requests and then blocks abuse with safe headers', async () => {
  const app = createApp({
    enableTestRoutes: true,
    securityToken: VALID_TOKEN,
    securityRateLimitMaxRequests: 2,
    securityRateLimitWindowMs: 60_000,
  });

  const first = await request(app)
    .get('/__test__/rate-limited')
    .set('Authorization', buildBearerHeader(VALID_TOKEN));
  const second = await request(app)
    .get('/__test__/rate-limited')
    .set('Authorization', buildBearerHeader(VALID_TOKEN));
  const third = await request(app)
    .get('/__test__/rate-limited')
    .set('Authorization', buildBearerHeader(VALID_TOKEN));

  assert.equal(first.status, 200);
  assert.equal(first.headers['x-ratelimit-limit'], '2');
  assert.equal(first.headers['x-ratelimit-remaining'], '1');

  assert.equal(second.status, 200);
  assert.equal(second.headers['x-ratelimit-remaining'], '0');

  assert.equal(third.status, 429);
  assertStructuredError(third, {
    code: 'RATE_LIMITED',
    message: 'Too many requests were sent to this endpoint.',
    retryable: true,
    retryHint: 'Wait for the rate-limit window to reset before retrying.',
  });
  assert.equal(third.headers['x-ratelimit-limit'], '2');
  assert.equal(third.headers['x-ratelimit-remaining'], '0');
  assert.match(third.headers['retry-after'], /^\d+$/);
});

test('rate limiter state stays isolated between app instances', async () => {
  const firstApp = createApp({
    enableTestRoutes: true,
    securityToken: VALID_TOKEN,
    securityRateLimitMaxRequests: 1,
    securityRateLimitWindowMs: 60_000,
  });
  const secondApp = createApp({
    enableTestRoutes: true,
    securityToken: VALID_TOKEN,
    securityRateLimitMaxRequests: 1,
    securityRateLimitWindowMs: 60_000,
  });

  const firstResponse = await request(firstApp)
    .get('/__test__/rate-limited')
    .set('Authorization', buildBearerHeader(VALID_TOKEN));
  const limitedResponse = await request(firstApp)
    .get('/__test__/rate-limited')
    .set('Authorization', buildBearerHeader(VALID_TOKEN));
  const isolatedResponse = await request(secondApp)
    .get('/__test__/rate-limited')
    .set('Authorization', buildBearerHeader(VALID_TOKEN));

  assert.equal(firstResponse.status, 200);
  assert.equal(limitedResponse.status, 429);
  assert.equal(isolatedResponse.status, 200);
});

test('sanitizeRequestId accepts a well-formed client id verbatim', () => {
  const valid = 'abc-123_DEF.456';
  assert.equal(sanitizeRequestId(valid), valid);
});

test('sanitizeRequestId rejects missing, empty, and non-string values', () => {
  assert.equal(sanitizeRequestId(undefined), null);
  assert.equal(sanitizeRequestId(null), null);
  assert.equal(sanitizeRequestId(''), null);
  // A repeated header is parsed as an array, not a string.
  assert.equal(sanitizeRequestId(['a', 'b']), null);
  assert.equal(sanitizeRequestId(42), null);
});

test('sanitizeRequestId caps oversized identifiers at the length bound', () => {
  const atLimit = 'a'.repeat(MAX_REQUEST_ID_LENGTH);
  const overLimit = 'a'.repeat(MAX_REQUEST_ID_LENGTH + 1);

  assert.equal(sanitizeRequestId(atLimit), atLimit);
  assert.equal(sanitizeRequestId(overLimit), null);
});

test('sanitizeRequestId rejects values outside the strict charset', () => {
  const disallowed = [
    'has space',
    'has/slash',
    'semi;colon',
    'angle<bracket>',
    'quote"value',
  ];

  for (const value of disallowed) {
    assert.equal(sanitizeRequestId(value), null);
  }
});

test('log-injection regression: CRLF and control chars never survive sanitization', () => {
  // These payloads would forge extra structured log lines if echoed verbatim.
  const injectionPayloads = [
    'valid\r\nlevel=ERROR injected',
    'valid\ninjected',
    'valid\rinjected',
    'valid\tinjected',
    `valid${String.fromCharCode(0)}null`,
    `valid${String.fromCharCode(7)}bell`,
    `valid${String.fromCharCode(27)}[31mansi`,
  ];

  for (const payload of injectionPayloads) {
    const result = sanitizeRequestId(payload);
    assert.equal(result, null);
    // Defense in depth: if a future change returns a string, it must be clean.
    if (typeof result === 'string') {
      assert.equal(/[\r\n\u0000-\u001f\u007f]/.test(result), false);
    }
  }
});

test('generateRequestId returns a full-strength UUID', () => {
  const id = generateRequestId();
  assert.match(id, UUID_PATTERN);
  assert.notEqual(generateRequestId(), id);
});

test('resolveRequestIdFromHeaders falls back to the alternate header only when it is clean', () => {
  const headers = {
    'x-request-id': 'bad id with spaces',
    'request-id': 'clean-alt-id_123',
  };

  assert.equal(resolveRequestIdFromHeaders(headers), 'clean-alt-id_123');
});

test('request id middleware echoes a valid client-supplied id', async () => {
  const app = createApp({ enableTestRoutes: true, securityToken: VALID_TOKEN });
  const clientId = 'client-supplied_REQUEST.123';

  const response = await request(app).get('/health').set('X-Request-Id', clientId);

  assert.equal(response.status, 200);
  assert.equal(response.headers['x-request-id'], clientId);
});

test('request id middleware replaces an oversized client id with a fresh UUID', async () => {
  const app = createApp({ enableTestRoutes: true, securityToken: VALID_TOKEN });
  const oversized = 'a'.repeat(MAX_REQUEST_ID_LENGTH + 50);

  const response = await request(app).get('/health').set('X-Request-Id', oversized);

  assert.equal(response.status, 200);
  assert.notEqual(response.headers['x-request-id'], oversized);
  assert.match(response.headers['x-request-id'], UUID_PATTERN);
});

test('request id middleware rejects ids with disallowed characters and echoes a clean UUID', async () => {
  const app = createApp({ enableTestRoutes: true, securityToken: VALID_TOKEN });

  // Spaces are transmissible over the wire but not part of the strict charset.
  const response = await request(app)
    .get('/health')
    .set('X-Request-Id', 'spoofed value with spaces');

  assert.equal(response.status, 200);
  const echoed = response.headers['x-request-id'];
  assert.match(echoed, UUID_PATTERN);
  // The echoed header must never carry a newline back to a client/log sink.
  assert.equal(/[\r\n]/.test(echoed), false);
});

test('request id middleware never binds injected header bytes into the request logger', () => {
  const req = {
    headers: {
      'x-request-id': 'valid\r\nlevel=ERROR injected',
    },
  };
  const responseHeaders = {};
  const res = {
    setHeader(name, value) {
      responseHeaders[name.toLowerCase()] = value;
    },
  };

  requestId(req, res, () => {});

  const boundRequestId = req.log.bindings().requestId;
  assert.match(req.id, UUID_PATTERN);
  assert.equal(boundRequestId, req.id);
  assert.equal(responseHeaders['x-request-id'], req.id);
  assert.equal(/[\r\n\u0000-\u001f\u007f]/.test(boundRequestId), false);
});

test('request id middleware keeps the logger and echoed header aligned to the same validated id', async () => {
  const app = express();
  app.use(requestId);
  app.get('/logger', (req, res) => {
    res.json({
      requestId: req.id,
      loggerBindings: req.log.bindings(),
    });
  });

  const response = await request(app).get('/logger').set('X-Request-Id', 'clean-client-id_42');

  assert.equal(response.status, 200);
  assert.equal(response.body.requestId, 'clean-client-id_42');
  assert.deepEqual(response.body.loggerBindings, { requestId: 'clean-client-id_42' });
  assert.equal(response.headers['x-request-id'], 'clean-client-id_42');
});

test('request id middleware generates an id when no header is provided', async () => {
  const app = createApp({ enableTestRoutes: true, securityToken: VALID_TOKEN });

  const response = await request(app).get('/health');

  assert.equal(response.status, 200);
  assert.match(response.headers['x-request-id'], UUID_PATTERN);
});

test('request id middleware treats an empty client header as missing and generates a fresh UUID', async () => {
  const app = createApp({ enableTestRoutes: true, securityToken: VALID_TOKEN });

  const response = await request(app).get('/health').set('X-Request-Id', '');

  assert.equal(response.status, 200);
  assert.match(response.headers['x-request-id'], UUID_PATTERN);
});

test('auth parsing helpers normalize and compare tokens safely', () => {
  assert.equal(parseBearerAuthorizationHeader('Bearer abc123'), 'abc123');
  assert.equal(tokensMatch('same-token', 'same-token'), true);
  assert.equal(tokensMatch('same-token', 'different-token'), false);
  assert.equal(tokensMatch('short', 'longer'), false);
});
