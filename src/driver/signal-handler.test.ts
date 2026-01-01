import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerSignalHandlers } from './signal-handler.js';
import type { DrainResult, Driver } from './types.js';

function createMockDriver(
  options: { drainResult?: DrainResult; drainDelay?: number } = {}
): Driver {
  const defaultResult: DrainResult = {
    success: true,
    completedQueries: 0,
    cancelledQueries: 0,
    elapsedMs: 100,
  };

  return {
    dialect: 'postgresql',
    connectionString: 'mock://connection',
    isDraining: false,
    query: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
    close: vi.fn(),
    getActiveQueryCount: vi.fn().mockReturnValue(0),
    drainAndClose: vi.fn().mockImplementation(async () => {
      if (options.drainDelay) {
        await new Promise((r) => setTimeout(r, options.drainDelay));
      }
      return options.drainResult ?? defaultResult;
    }),
  };
}

describe('registerSignalHandlers', () => {
  let originalExit: typeof process.exit;
  let mockExit: ReturnType<typeof vi.fn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalExit = process.exit;
    mockExit = vi.fn();
    process.exit = mockExit as unknown as typeof process.exit;
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.exit = originalExit;
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
  });

  it('should register SIGTERM and SIGINT handlers', () => {
    const driver = createMockDriver();
    const sigtermBefore = process.listenerCount('SIGTERM');
    const sigintBefore = process.listenerCount('SIGINT');

    registerSignalHandlers(driver);

    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore + 1);
    expect(process.listenerCount('SIGINT')).toBe(sigintBefore + 1);
  });

  it('should return unregister function that removes handlers', () => {
    const driver = createMockDriver();
    const sigtermBefore = process.listenerCount('SIGTERM');
    const sigintBefore = process.listenerCount('SIGINT');

    const unregister = registerSignalHandlers(driver);
    unregister();

    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
    expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
  });

  it('should call drainAndClose on SIGTERM', async () => {
    const driver = createMockDriver();
    registerSignalHandlers(driver, { autoExit: false });

    process.emit('SIGTERM');

    await vi.waitFor(() => {
      expect(driver.drainAndClose).toHaveBeenCalled();
    });
  });

  it('should call drainAndClose on SIGINT', async () => {
    const driver = createMockDriver();
    registerSignalHandlers(driver, { autoExit: false });

    process.emit('SIGINT');

    await vi.waitFor(() => {
      expect(driver.drainAndClose).toHaveBeenCalled();
    });
  });

  it('should pass timeout option to drainAndClose', async () => {
    const driver = createMockDriver();
    registerSignalHandlers(driver, { timeout: 5000, autoExit: false });

    process.emit('SIGTERM');

    await vi.waitFor(() => {
      expect(driver.drainAndClose).toHaveBeenCalledWith(expect.objectContaining({ timeout: 5000 }));
    });
  });

  it('should call onShutdownStart callback', async () => {
    const driver = createMockDriver();
    const onShutdownStart = vi.fn();
    registerSignalHandlers(driver, { onShutdownStart, autoExit: false });

    process.emit('SIGTERM');

    await vi.waitFor(() => {
      expect(onShutdownStart).toHaveBeenCalled();
    });
  });

  it('should call onShutdownComplete callback with result', async () => {
    const drainResult: DrainResult = {
      success: true,
      completedQueries: 5,
      cancelledQueries: 2,
      elapsedMs: 500,
    };
    const driver = createMockDriver({ drainResult });
    const onShutdownComplete = vi.fn();
    registerSignalHandlers(driver, { onShutdownComplete, autoExit: false });

    process.emit('SIGTERM');

    await vi.waitFor(() => {
      expect(onShutdownComplete).toHaveBeenCalledWith(drainResult);
    });
  });

  it('should exit with success code when no queries cancelled', async () => {
    const driver = createMockDriver({
      drainResult: {
        success: true,
        completedQueries: 5,
        cancelledQueries: 0,
        elapsedMs: 100,
      },
    });
    registerSignalHandlers(driver, { exitCodeSuccess: 0 });

    process.emit('SIGTERM');

    await vi.waitFor(() => {
      expect(mockExit).toHaveBeenCalledWith(0);
    });
  });

  it('should exit with forced code when queries were cancelled', async () => {
    const driver = createMockDriver({
      drainResult: {
        success: true,
        completedQueries: 3,
        cancelledQueries: 2,
        elapsedMs: 100,
      },
    });
    registerSignalHandlers(driver, { exitCodeForced: 1 });

    process.emit('SIGTERM');

    await vi.waitFor(() => {
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  it('should not exit when autoExit is false', async () => {
    const driver = createMockDriver();
    registerSignalHandlers(driver, { autoExit: false });

    process.emit('SIGTERM');

    await vi.waitFor(() => {
      expect(driver.drainAndClose).toHaveBeenCalled();
    });

    expect(mockExit).not.toHaveBeenCalled();
  });

  it('should ignore duplicate signals while shutting down', async () => {
    const driver = createMockDriver({ drainDelay: 100 });
    registerSignalHandlers(driver, { autoExit: false });

    process.emit('SIGTERM');
    process.emit('SIGTERM');
    process.emit('SIGINT');

    await vi.waitFor(() => {
      expect(driver.drainAndClose).toHaveBeenCalled();
    });

    expect(driver.drainAndClose).toHaveBeenCalledTimes(1);
  });

  it('should log shutdown progress', async () => {
    const driver = createMockDriver();
    registerSignalHandlers(driver, { autoExit: false });

    process.emit('SIGTERM');

    await vi.waitFor(() => {
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Received SIGTERM'));
    });
  });

  it('should handle errors during shutdown', async () => {
    const error = new Error('Drain failed');
    const driver = createMockDriver();
    (driver.drainAndClose as ReturnType<typeof vi.fn>).mockRejectedValue(error);

    registerSignalHandlers(driver);

    process.emit('SIGTERM');

    await vi.waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error during shutdown'),
        error
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
