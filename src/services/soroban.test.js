const {
  callSorobanContract,
  classifySorobanError,
  isRetryable,
} = require('./soroban');

describe('Soroban Integration Wrapper', () => {

  describe('callSorobanContract', () => {
    it('should execute successfully without retries', async () => {
      const operation = jest.fn().mockResolvedValue('success');
      const result = await callSorobanContract(operation);
      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should retry on transient errors using the wrapper', async () => {
      let attempts = 0;
      const operation = jest.fn().mockImplementation(() => {
        attempts++;
        if (attempts < 2) {
          const err = new Error('503 Service Unavailable');
          err.status = 503;
          return Promise.reject(err);
        }
        return Promise.resolve('recovered');
      });

      const result = await callSorobanContract(operation);
      expect(result).toBe('recovered');
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it('should fail immediately on non-transient error', async () => {
      const error = new Error('Invalid arguments');
      const operation = jest.fn().mockRejectedValue(error);

      await expect(callSorobanContract(operation)).rejects.toThrow('Invalid arguments');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should trip the circuit breaker on sustained transient errors', async () => {
      const { sharedBreaker } = require('./soroban');

      // Reset breaker state for clean test
      sharedBreaker.state = 'CLOSED';
      sharedBreaker.failureCount = 0;

      const operation = jest.fn().mockImplementation(() => {
        const err = new Error('503 Service Unavailable');
        err.status = 503;
        return Promise.reject(err);
      });

      // Provide a fast retry config so test doesn't hang
      const fastConfig = { maxRetries: 0, baseDelay: 0, maxDelay: 0 };

      // Fail enough times to trip the breaker (default threshold is 5)
      for (let i = 0; i < 5; i++) {
        await expect(callSorobanContract(operation, fastConfig)).rejects.toThrow('503 Service Unavailable');
      }

      // Next call should fail fast from the breaker
      const fastFailOp = jest.fn();
      let caughtError;
      try {
        await callSorobanContract(fastFailOp, fastConfig);
      } catch (e) {
        caughtError = e;
      }

      expect(caughtError).toBeDefined();
      expect(caughtError.code).toBe('CIRCUIT_OPEN');
      expect(fastFailOp).not.toHaveBeenCalled();
    });
  });

  // ─── classifySorobanError — table-driven classifier tests ────────────────────

  describe('classifySorobanError — unified Soroban error classifier', () => {
    // Each row: [label, err, expected]. Keep exhaustive so any future
    // regression in signal priority / word-boundary behavior fails loudly.
    const CASES = [
      // ── Network codes (case-insensitive)
      ['ETIMEDOUT uppercase', { code: 'ETIMEDOUT' }, { retryable: true, category: 'network' }],
      ['ETIMEDOUT lowercase', { code: 'etimedout' }, { retryable: true, category: 'network' }],
      ['ECONNRESET', { code: 'ECONNRESET' }, { retryable: true, category: 'network' }],
      ['ECONNREFUSED', { code: 'ECONNREFUSED' }, { retryable: true, category: 'network' }],
      ['unrelated errno (EACCES)', { code: 'EACCES' }, { retryable: false, category: 'permanent' }],

      // ── Structured HTTP status (top-level)
      ['status 429', { status: 429 }, { retryable: true, category: 'rate-limit' }],
      ['status 502', { status: 502 }, { retryable: true, category: 'rpc-5xx' }],
      ['status 503', { status: 503 }, { retryable: true, category: 'rpc-5xx' }],
      ['status 504', { status: 504 }, { retryable: true, category: 'rpc-5xx' }],
      ['status 400 (client)', { status: 400 }, { retryable: false, category: 'permanent' }],
      ['status 500 (generic 5xx)', { status: 500 }, { retryable: false, category: 'permanent' }],
      ['status 401 (auth)', { status: 401 }, { retryable: false, category: 'permanent' }],
      ['status undefined', { status: undefined }, { retryable: false, category: 'permanent' }],
      ['status null', { status: null }, { retryable: false, category: 'permanent' }],
      ['status string "429" (not integer)', { status: '429' }, { retryable: false, category: 'permanent' }],

      // ── Structured HTTP status on .response object
      ['response.status 429', { response: { status: 429 } }, { retryable: true, category: 'rate-limit' }],
      ['response.status 503', { response: { status: 503 } }, { retryable: true, category: 'rpc-5xx' }],
      ['response.status 404', { response: { status: 404 } }, { retryable: false, category: 'permanent' }],

      // ── Message-only rate-limit signals (phrase patterns)
      ['message "Too Many Requests"', { message: 'Too Many Requests' }, { retryable: true, category: 'rate-limit' }],
      ['message "rate limit exceeded"', { message: 'rate limit exceeded' }, { retryable: true, category: 'rate-limit' }],
      ['message "rate-limited: try again"', { message: 'rate-limited: try again' }, { retryable: true, category: 'rate-limit' }],
      ['message "Rate Exceeded"', { message: 'Rate Exceeded for tenant', }, { retryable: true, category: 'rate-limit' }],

      // ── Message-only 5xx / gateway signals (phrase patterns)
      ['message "Service Unavailable"', { message: 'Service Unavailable' }, { retryable: true, category: 'rpc-5xx' }],
      ['message "Bad Gateway"', { message: 'Bad Gateway' }, { retryable: true, category: 'rpc-5xx' }],
      ['message "Gateway Timeout"', { message: 'Gateway Timeout' }, { retryable: true, category: 'rpc-5xx' }],
      ['message full HTTP envelope', { message: 'HTTP/1.1 503 Service Unavailable' }, { retryable: true, category: 'rpc-5xx' }],

      // ── Message-only network signals (word-boundary regexes)
      ['message "connection timeout"', { message: 'connection timeout' }, { retryable: true, category: 'network' }],
      ['message "Timed out waiting for response"', { message: 'Timed out waiting for response' }, { retryable: true, category: 'network' }],
      ['message includes "ETIMEDOUT"', { message: 'Error: ETIMEDOUT code fired' }, { retryable: true, category: 'network' }],
      ['message ECONNREFUSED', { message: 'something ECONNREFUSED happened' }, { retryable: true, category: 'network' }],
      ['message ECONNRESET', { message: 'something ECONNRESET happened' }, { retryable: true, category: 'network' }],
      ['message "network down"', { message: 'network down' }, { retryable: true, category: 'network' }],

      // ── Bare-digit status mentions in messages are NOT auto-classified.
      // These were the most common injection vector in the original substring
      // implementation; the unified classifier deliberately requires the
      // canonical HTTP phrases.
      ['bare "503" alone is NOT transient', { message: 'failed with 503' }, { retryable: false, category: 'permanent' }],
      ['bare "request 503 issued" NOT transient', { message: 'request 503 issued' }, { retryable: false, category: 'permanent' }],
      ['bare "limit 429 reached" NOT transient', { message: 'limit 429 reached' }, { retryable: false, category: 'permanent' }],

      // ── Permanent messages
      ['message "Invalid arguments"', { message: 'Invalid arguments' }, { retryable: false, category: 'permanent' }],
      ['message "malformed transaction xdr"', { message: 'malformed transaction xdr' }, { retryable: false, category: 'permanent' }],
      ['message "bad signature"', { message: 'bad signature' }, { retryable: false, category: 'permanent' }],
      ['message "account not found"', { message: 'account not found' }, { retryable: false, category: 'permanent' }],
      ['message "insufficient base fee"', { message: 'insufficient base fee' }, { retryable: false, category: 'permanent' }],

      // ── Attacker-controlled message injection (must NOT be coerced to retryable)
      // The classifier strips transient signals from user-controlled text fields
      // because the patterns now require canonical multi-word phrases.
      ['injection "User 503abc rejected"', { message: 'User 503abc rejected' }, { retryable: false, category: 'permanent' }],
      ['injection "User 503 not found" (residual risk: spaceless digits)', { message: 'User 503 not found' }, { retryable: false, category: 'permanent' }],
      ['injection "order429pending"', { message: 'order429pending' }, { retryable: false, category: 'permanent' }],
      ['injection "5031 failed"', { message: '5031 failed' }, { retryable: false, category: 'permanent' }],
      ['injection "timeout_policy_violation" (no word boundary)', { message: 'timeout_policy_violation' }, { retryable: false, category: 'permanent' }],
      ['injection "econnrefused_handler fed back"', { message: 'econnrefused_handler fed back' }, { retryable: false, category: 'permanent' }],
      ['injection "rate-limiter-disabled notice"', { message: 'rate-limiter-disabled notice' }, { retryable: false, category: 'permanent' }],
      ['injection "rate_limited_user config"', { message: 'rate_limited_user config' }, { retryable: false, category: 'permanent' }],
      ['injection "service_unavailable_for_test"', { message: 'service_unavailable_for_test' }, { retryable: false, category: 'permanent' }],
      ['injection "bad_gateway_handler ran"', { message: 'bad_gateway_handler ran' }, { retryable: false, category: 'permanent' }],

      // ── Multi-signal combinations — first match wins (priority order)
      // Signals are evaluated in this order: structured code → structured
      // status → message phrase. Code takes priority over status (transport
      // errors are the most common source of retryable failures).
      ['code + status: ECONNRESET + 503 returns code first', { code: 'ECONNRESET', status: 503 }, { retryable: true, category: 'network' }],
      ['code + status: non-transient code + retryable 503 → status retryable', { code: 'EACCES', status: 503 }, { retryable: true, category: 'rpc-5xx' }],
      ['code + message: ECONNRESET + permanent message → code wins', { code: 'ECONNRESET', message: 'bad signature' }, { retryable: true, category: 'network' }],
      ['status + message: 503 + permanent message → status wins', { status: 503, message: 'malformed transaction xdr' }, { retryable: true, category: 'rpc-5xx' }],

      // ── Edge-case error shapes
      ['null error', null, { retryable: false, category: 'permanent' }],
      ['undefined error', undefined, { retryable: false, category: 'permanent' }],
      ['plain string error', '503', { retryable: false, category: 'permanent' }],
      ['plain number error', 503, { retryable: false, category: 'permanent' }],
      ['plain boolean error', true, { retryable: false, category: 'permanent' }],
      ['empty object', {}, { retryable: false, category: 'permanent' }],
      ['object with non-string code', { code: 429 }, { retryable: false, category: 'permanent' }],
      ['object with non-string status', { status: 'five hundred' }, { retryable: false, category: 'permanent' }],
      ['object with float status', { status: 429.5 }, { retryable: false, category: 'permanent' }],
      ['message is empty string', { message: '' }, { retryable: false, category: 'permanent' }],
      ['message is non-string', { message: 503 }, { retryable: false, category: 'permanent' }],
    ];

    it.each(CASES)('%s', (_label, err, expected) => {
      const result = classifySorobanError(err);
      expect(result.retryable).toBe(expected.retryable);
      expect(result.category).toBe(expected.category);
      expect(typeof result.reason).toBe('string');
      expect(result.reason.length).toBeGreaterThan(0);
    });

    it('returns a `reason` of "no-transient-signal" for permanent errors', () => {
      const result = classifySorobanError(new Error('Invalid arguments'));
      expect(result.reason).toBe('no-transient-signal');
    });

    it('returns a `reason` of "invalid-error-shape" for non-object inputs', () => {
      for (const bad of [null, undefined, '503', 503, true, false, () => {}]) {
        expect(classifySorobanError(bad).reason).toBe('invalid-error-shape');
      }
    });

    it('prioritizes structured status over message: status=429 wins over bad message', () => {
      const err = { status: 429, message: 'malformed transaction xdr' };
      expect(classifySorobanError(err)).toEqual({
        retryable: true,
        category: 'rate-limit',
        reason: 'status:429',
      });
    });

    it('prioritizes structured code over message: ECONNRESET wins over bad message', () => {
      const err = { code: 'ECONNRESET', message: 'malformed transaction xdr' };
      expect(classifySorobanError(err)).toEqual({
        retryable: true,
        category: 'network',
        reason: 'network-code:ECONNRESET',
      });
    });

    it('is idempotent / pure (same input → same output, no shared state)', () => {
      const err = { status: 503 };
      const a = classifySorobanError(err);
      const b = classifySorobanError(err);
      expect(a).toEqual(b);
    });
  });

  // ─── isRetryable — legacy boolean wrapper covered by classifySorobanError ────

  describe('isRetryable (boolean wrapper around classifySorobanError)', () => {
    it('returns true for status 503', () => {
      expect(isRetryable({ status: 503 })).toBe(true);
    });
    it('returns true for ETIMEDOUT code', () => {
      expect(isRetryable({ code: 'ETIMEDOUT' })).toBe(true);
    });
    it('returns true for "timeout" message', () => {
      expect(isRetryable(new Error('Request timeout'))).toBe(true);
    });
    it('returns false for permanent Error', () => {
      expect(isRetryable(new Error('Account not found'))).toBe(false);
    });
    it('returns false for null/undefined/primitive', () => {
      expect(isRetryable(null)).toBe(false);
      expect(isRetryable(undefined)).toBe(false);
      expect(isRetryable('timeout')).toBe(false);
      expect(isRetryable(503)).toBe(false);
    });
  });
});
