import type { Driver, DrainResult } from './types.js';

export interface SignalHandlerOptions {
  timeout?: number;
  exitCodeSuccess?: number;
  exitCodeForced?: number;
  autoExit?: boolean;
  onShutdownStart?: () => void;
  onShutdownComplete?: (result: DrainResult) => void;
}

export function registerSignalHandlers(
  driver: Driver,
  options: SignalHandlerOptions = {}
): () => void {
  const {
    timeout = 30000,
    exitCodeSuccess = 0,
    exitCodeForced = 1,
    autoExit = true,
    onShutdownStart,
    onShutdownComplete,
  } = options;

  let shuttingDown = false;

  const handleSignal = async (signal: string) => {
    if (shuttingDown) {
      console.log(`[db-engine] Already shutting down, ignoring ${signal}`);
      return;
    }

    shuttingDown = true;
    console.log(`[db-engine] Received ${signal}, starting graceful shutdown`);
    onShutdownStart?.();

    try {
      const result = await driver.drainAndClose({
        timeout,
        onProgress: (progress) => {
          console.log(
            `[db-engine] Shutdown progress: ${progress.phase} - ` +
              `${progress.activeQueries} active, ${progress.completedQueries} completed`
          );
        },
      });

      onShutdownComplete?.(result);

      if (autoExit) {
        const exitCode = result.cancelledQueries > 0 ? exitCodeForced : exitCodeSuccess;
        process.exit(exitCode);
      }
    } catch (error) {
      console.error('[db-engine] Error during shutdown:', error);
      if (autoExit) {
        process.exit(1);
      }
    }
  };

  const sigterm = () => {
    handleSignal('SIGTERM');
  };
  const sigint = () => {
    handleSignal('SIGINT');
  };

  process.on('SIGTERM', sigterm);
  process.on('SIGINT', sigint);

  return () => {
    process.off('SIGTERM', sigterm);
    process.off('SIGINT', sigint);
  };
}
