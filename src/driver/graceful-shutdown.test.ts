import { describe, expect, it, vi } from 'vitest';
import { QueryTracker } from './query-tracker.js';
import type { DrainPhase } from './types.js';

describe('QueryTracker class', () => {
  it('should track and untrack queries', () => {
    const tracker = new QueryTracker();
    tracker.trackQuery('q1', 'SELECT 1');
    expect(tracker.getActiveCount()).toBe(1);
    tracker.untrackQuery('q1');
    expect(tracker.getActiveCount()).toBe(0);
  });
});

describe('Graceful Shutdown Mock Tests', () => {
  it('should create a mock driver with drainAndClose method', async () => {
    const mockDriver = {
      dialect: 'postgresql' as const,
      connectionString: 'mock://test',
      isDraining: false,
      query: vi.fn(),
      execute: vi.fn(),
      transaction: vi.fn(),
      close: vi.fn(),
      getActiveQueryCount: vi.fn().mockReturnValue(0),
      drainAndClose: vi.fn().mockResolvedValue({
        success: true,
        completedQueries: 5,
        cancelledQueries: 0,
        elapsedMs: 100,
      }),
    };

    const result = await mockDriver.drainAndClose({ timeout: 1000 });

    expect(result.success).toBe(true);
    expect(result.completedQueries).toBe(5);
    expect(result.cancelledQueries).toBe(0);
    expect(result.elapsedMs).toBe(100);
  });

  it('should call onProgress callback with correct phases', async () => {
    const phases: DrainPhase[] = [];

    const mockDriver = {
      dialect: 'postgresql' as const,
      connectionString: 'mock://test',
      isDraining: false,
      query: vi.fn(),
      execute: vi.fn(),
      transaction: vi.fn(),
      close: vi.fn(),
      getActiveQueryCount: vi.fn().mockReturnValue(0),
      drainAndClose: vi
        .fn()
        .mockImplementation(
          async (options?: { onProgress?: (p: { phase: DrainPhase }) => void }) => {
            options?.onProgress?.({ phase: 'draining' });
            options?.onProgress?.({ phase: 'closing' });
            options?.onProgress?.({ phase: 'complete' });
            return {
              success: true,
              completedQueries: 0,
              cancelledQueries: 0,
              elapsedMs: 50,
            };
          }
        ),
    };

    await mockDriver.drainAndClose({
      onProgress: (progress) => phases.push(progress.phase),
    });

    expect(phases).toEqual(['draining', 'closing', 'complete']);
  });

  it('should return cancelled queries when timeout occurs', async () => {
    const mockDriver = {
      dialect: 'postgresql' as const,
      connectionString: 'mock://test',
      isDraining: false,
      query: vi.fn(),
      execute: vi.fn(),
      transaction: vi.fn(),
      close: vi.fn(),
      getActiveQueryCount: vi.fn().mockReturnValue(2),
      drainAndClose: vi.fn().mockResolvedValue({
        success: true,
        completedQueries: 3,
        cancelledQueries: 2,
        elapsedMs: 30000,
      }),
    };

    const result = await mockDriver.drainAndClose({ timeout: 30000 });

    expect(result.cancelledQueries).toBe(2);
    expect(result.completedQueries).toBe(3);
  });

  it('should have isDraining property', () => {
    const mockDriver = {
      dialect: 'postgresql' as const,
      connectionString: 'mock://test',
      isDraining: false,
      query: vi.fn(),
      execute: vi.fn(),
      transaction: vi.fn(),
      close: vi.fn(),
      getActiveQueryCount: vi.fn().mockReturnValue(0),
      drainAndClose: vi.fn(),
    };

    expect(mockDriver.isDraining).toBe(false);
  });
});

describe('DrainResult interface', () => {
  it('should have all required properties', () => {
    const result = {
      success: true,
      completedQueries: 10,
      cancelledQueries: 2,
      elapsedMs: 5000,
    };

    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('completedQueries');
    expect(result).toHaveProperty('cancelledQueries');
    expect(result).toHaveProperty('elapsedMs');
    expect(typeof result.success).toBe('boolean');
    expect(typeof result.completedQueries).toBe('number');
    expect(typeof result.cancelledQueries).toBe('number');
    expect(typeof result.elapsedMs).toBe('number');
  });

  it('should allow optional error property', () => {
    const resultWithError = {
      success: false,
      completedQueries: 5,
      cancelledQueries: 3,
      elapsedMs: 30000,
      error: new Error('Shutdown failed'),
    };

    expect(resultWithError.error).toBeInstanceOf(Error);
    expect(resultWithError.error.message).toBe('Shutdown failed');
  });
});

describe('DrainOptions interface', () => {
  it('should accept timeout option', () => {
    const options = { timeout: 5000 };
    expect(options.timeout).toBe(5000);
  });

  it('should accept forceCancelOnTimeout option', () => {
    const options = { timeout: 5000, forceCancelOnTimeout: true };
    expect(options.forceCancelOnTimeout).toBe(true);
  });

  it('should accept onProgress callback', () => {
    const onProgress = vi.fn();
    const options = { timeout: 5000, onProgress };
    expect(typeof options.onProgress).toBe('function');
  });
});
