import { describe, expect, it, vi } from 'vitest';
import { createTimeoutPromise, isRetryableError, withRetry } from './retry.js';

describe('Retry Utilities', () => {
  describe('isRetryableError', () => {
    it('should return true for ECONNREFUSED error code', () => {
      const error = new Error('Connection refused');
      (error as Error & { code: string }).code = 'ECONNREFUSED';

      expect(isRetryableError(error)).toBe(true);
    });

    it('should return true for ETIMEDOUT error code', () => {
      const error = new Error('Connection timed out');
      (error as Error & { code: string }).code = 'ETIMEDOUT';

      expect(isRetryableError(error)).toBe(true);
    });

    it('should return true for ECONNRESET error code', () => {
      const error = new Error('Connection reset');
      (error as Error & { code: string }).code = 'ECONNRESET';

      expect(isRetryableError(error)).toBe(true);
    });

    it('should return true for PostgreSQL admin_shutdown (57P01)', () => {
      const error = new Error('57P01: server is shutting down');

      expect(isRetryableError(error)).toBe(true);
    });

    it('should return true for PostgreSQL crash_shutdown (57P02)', () => {
      const error = new Error('57P02: server crashed');

      expect(isRetryableError(error)).toBe(true);
    });

    it('should return true for MySQL PROTOCOL_CONNECTION_LOST', () => {
      const error = new Error('PROTOCOL_CONNECTION_LOST');

      expect(isRetryableError(error)).toBe(true);
    });

    it('should return true for MySQL too many connections', () => {
      const error = new Error('ER_CON_COUNT_ERROR: Too many connections');

      expect(isRetryableError(error)).toBe(true);
    });

    it('should return false for non-retryable errors', () => {
      const error = new Error('Syntax error in query');

      expect(isRetryableError(error)).toBe(false);
    });

    it('should return false for null', () => {
      expect(isRetryableError(null)).toBe(false);
    });

    it('should return false for undefined', () => {
      expect(isRetryableError(undefined)).toBe(false);
    });

    it('should return false for string', () => {
      expect(isRetryableError('error')).toBe(false);
    });

    it('should check custom error codes', () => {
      const error = new Error('Custom error');
      (error as Error & { code: string }).code = 'CUSTOM_ERROR';

      expect(isRetryableError(error)).toBe(false);
      expect(isRetryableError(error, ['CUSTOM_ERROR'])).toBe(true);
    });

    it('should check custom error messages', () => {
      const error = new Error('Custom transient failure');

      expect(isRetryableError(error)).toBe(false);
      expect(isRetryableError(error, ['Custom transient'])).toBe(true);
    });
  });

  describe('withRetry', () => {
    it('should return result on first successful attempt', async () => {
      const operation = vi.fn().mockResolvedValue('success');

      const result = await withRetry(operation);

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should retry on retryable error and succeed', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const error = new Error('Connection refused');
      (error as Error & { code: string }).code = 'ECONNREFUSED';

      const operation = vi.fn().mockRejectedValueOnce(error).mockResolvedValue('success');

      const result = await withRetry(operation, {
        maxRetries: 2,
        baseDelayMs: 1,
        maxDelayMs: 5,
      });

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it('should throw immediately on non-retryable error', async () => {
      const error = new Error('Syntax error');
      const operation = vi.fn().mockRejectedValue(error);

      await expect(withRetry(operation)).rejects.toThrow('Syntax error');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should throw after max retries exceeded', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const error = new Error('Connection refused');
      (error as Error & { code: string }).code = 'ECONNREFUSED';

      const operation = vi.fn().mockRejectedValue(error);

      await expect(
        withRetry(operation, {
          maxRetries: 2,
          baseDelayMs: 1,
          maxDelayMs: 5,
        })
      ).rejects.toThrow('Connection refused');
      expect(operation).toHaveBeenCalledTimes(3);
    });

    it('should log warning on retry', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const error = new Error('Connection refused');
      (error as Error & { code: string }).code = 'ECONNREFUSED';

      const operation = vi.fn().mockRejectedValueOnce(error).mockResolvedValue('success');

      await withRetry(operation, {
        maxRetries: 2,
        baseDelayMs: 1,
        maxDelayMs: 5,
      });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Connection error'),
        expect.any(String)
      );

      warnSpy.mockRestore();
    });

    it('should use default values for config', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const error = new Error('Connection refused');
      (error as Error & { code: string }).code = 'ECONNREFUSED';

      let callCount = 0;
      const operation = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount < 3) {
          throw error;
        }
        return 'success';
      });

      const result = await withRetry(operation, {
        baseDelayMs: 1,
        maxDelayMs: 5,
      });

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(3);
    });
  });

  describe('createTimeoutPromise', () => {
    it('should reject after specified timeout', async () => {
      vi.useFakeTimers();

      const promise = createTimeoutPromise(1000);

      vi.advanceTimersByTime(1000);

      await expect(promise).rejects.toThrow('Health check timeout');

      vi.useRealTimers();
    });

    it('should work with short timeout', async () => {
      const promise = createTimeoutPromise(1);

      await expect(promise).rejects.toThrow('Health check timeout');
    });
  });
});
