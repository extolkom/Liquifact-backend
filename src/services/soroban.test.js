const { callSorobanContract } = require('./soroban');

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
});
