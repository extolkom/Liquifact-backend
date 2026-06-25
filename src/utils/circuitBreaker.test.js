const { CircuitBreaker, CircuitBreakerState } = require('./circuitBreaker');

describe('CircuitBreaker', () => {
    let cb;

    beforeEach(() => {
        jest.useFakeTimers();
        cb = new CircuitBreaker({
            failureThreshold: 3,
            recoveryTimeout: 5000
        });
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    it('should execute successfully in CLOSED state', async () => {
        const operation = jest.fn().mockResolvedValue('success');
        const result = await cb.execute(operation);

        expect(result).toBe('success');
        expect(cb.state).toBe(CircuitBreakerState.CLOSED);
        expect(cb.failureCount).toBe(0);
        expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should transition from CLOSED to OPEN after reaching failure threshold', async () => {
        const operation = jest.fn().mockRejectedValue(new Error('failure'));

        // Attempt 1
        await expect(cb.execute(operation)).rejects.toThrow('failure');
        expect(cb.state).toBe(CircuitBreakerState.CLOSED);
        expect(cb.failureCount).toBe(1);

        // Attempt 2
        await expect(cb.execute(operation)).rejects.toThrow('failure');
        expect(cb.state).toBe(CircuitBreakerState.CLOSED);
        expect(cb.failureCount).toBe(2);

        // Attempt 3 (Threshold reached)
        await expect(cb.execute(operation)).rejects.toThrow('failure');
        expect(cb.state).toBe(CircuitBreakerState.OPEN);
        expect(cb.failureCount).toBe(3);
    });

    it('should fail fast when in OPEN state without calling operation', async () => {
        cb.state = CircuitBreakerState.OPEN;
        cb.nextAttemptTime = Date.now() + 5000;

        const operation = jest.fn();

        let caughtError;
        try {
            await cb.execute(operation);
        } catch (err) {
            caughtError = err;
        }

        expect(caughtError).toBeDefined();
        expect(caughtError.message).toBe('Circuit Breaker is OPEN. Operation failed fast.');
        expect(caughtError.code).toBe('CIRCUIT_OPEN');
        expect(operation).not.toHaveBeenCalled();
    });

    it('should use fallback logic if provided and circuit is OPEN', async () => {
        cb = new CircuitBreaker({
            failureThreshold: 1,
            recoveryTimeout: 10000,
            fallbackLogic: () => 'fallback data'
        });

        const operation = jest.fn().mockRejectedValue(new Error('failure'));

        // First attempt fails, opens circuit
        const result1 = await cb.execute(operation);
        expect(result1).toBe('fallback data');
        expect(cb.state).toBe(CircuitBreakerState.OPEN);

        // Second attempt hits OPEN state immediately and returns fallback
        const result2 = await cb.execute(operation);
        expect(result2).toBe('fallback data');
        expect(operation).toHaveBeenCalledTimes(1); // operation not called again
    });

    it('should transition to HALF_OPEN after recovery timeout', async () => {
        cb.state = CircuitBreakerState.OPEN;
        cb.nextAttemptTime = Date.now() - 1; // Simulate time passed

        const operation = jest.fn().mockResolvedValue('success in half open');

        const result = await cb.execute(operation);

        expect(result).toBe('success in half open');
        expect(operation).toHaveBeenCalledTimes(1);
        expect(cb.state).toBe(CircuitBreakerState.CLOSED);
        expect(cb.failureCount).toBe(0);
    });

    it('should transition back to OPEN if HALF_OPEN operation fails', async () => {
        cb.state = CircuitBreakerState.OPEN;
        cb.nextAttemptTime = Date.now() - 1; // Simulate time passed

        const operation = jest.fn().mockRejectedValue(new Error('failed again'));

        await expect(cb.execute(operation)).rejects.toThrow('failed again');

        expect(operation).toHaveBeenCalledTimes(1);
        expect(cb.state).toBe(CircuitBreakerState.OPEN);
        expect(cb.failureCount).toBe(1); // incremented
    });

    it('should trigger onStateChange callback upon state transitions', async () => {
        const onStateChange = jest.fn();
        cb = new CircuitBreaker({
            failureThreshold: 1,
            recoveryTimeout: 5000,
            onStateChange
        });

        const operation = jest.fn().mockRejectedValue(new Error('failure'));

        // Trip the breaker
        await expect(cb.execute(operation)).rejects.toThrow('failure');
        expect(onStateChange).toHaveBeenCalledWith(CircuitBreakerState.CLOSED, CircuitBreakerState.OPEN);

        // Fast fail won't transition
        await expect(cb.execute(operation)).rejects.toThrow('Circuit Breaker is OPEN. Operation failed fast.');
        expect(onStateChange).toHaveBeenCalledTimes(1);

        // Advance time to HALF_OPEN
        jest.setSystemTime(Date.now() + 5001);
        operation.mockResolvedValue('success');
        await cb.execute(operation);
        
        expect(onStateChange).toHaveBeenCalledWith(CircuitBreakerState.OPEN, CircuitBreakerState.HALF_OPEN);
        expect(onStateChange).toHaveBeenCalledWith(CircuitBreakerState.HALF_OPEN, CircuitBreakerState.CLOSED);
        expect(onStateChange).toHaveBeenCalledTimes(3);
    });
});
