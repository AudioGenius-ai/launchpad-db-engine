import postgres, { type ParameterOrJSON } from 'postgres';
import type { QueryResult } from '../types/index.js';
import {
  type HealthCheckResult,
  type PoolStats,
  createHealthCheckResult,
  getDefaultHealthCheckConfig,
} from './health.js';
import { QueryTracker } from './query-tracker.js';
import { createTimeoutPromise } from './retry.js';
import type { Driver, DriverConfig, DrainOptions, DrainResult, TransactionClient } from './types.js';

export function createPostgresDriver(config: DriverConfig): Driver {
  const sql = postgres(config.connectionString, {
    max: config.max ?? 20,
    idle_timeout: config.idleTimeout ?? 30,
    connect_timeout: config.connectTimeout ?? 10,
    prepare: true,
  });

  const maxConnections = config.max ?? 20;

  let lastHealthCheck: HealthCheckResult = createHealthCheckResult(true, 0);
  let healthCheckInterval: ReturnType<typeof setInterval> | null = null;

  const healthCheckConfig = getDefaultHealthCheckConfig(config.healthCheck);

  const tracker = new QueryTracker();
  let queryIdCounter = 0;
  let draining = false;

  const generateQueryId = () => `pg-${++queryIdCounter}`;

  async function performHealthCheck(): Promise<HealthCheckResult> {
    const startTime = Date.now();
    try {
      await Promise.race([
        sql`SELECT 1`,
        createTimeoutPromise<never>(healthCheckConfig.timeoutMs ?? 5000),
      ]);

      const result = createHealthCheckResult(true, Date.now() - startTime);

      if (!lastHealthCheck.healthy && healthCheckConfig.onHealthChange) {
        healthCheckConfig.onHealthChange(true, result);
      }

      lastHealthCheck = result;
      return result;
    } catch (error) {
      const result = createHealthCheckResult(
        false,
        Date.now() - startTime,
        error instanceof Error ? error.message : 'Unknown error'
      );

      if (lastHealthCheck.healthy && healthCheckConfig.onHealthChange) {
        healthCheckConfig.onHealthChange(false, result);
      }

      lastHealthCheck = result;
      return result;
    }
  }

  return {
    dialect: 'postgresql',
    connectionString: config.connectionString,

    get isDraining() {
      return draining;
    },

    async query<T = Record<string, unknown>>(
      queryText: string,
      params: unknown[] = []
    ): Promise<QueryResult<T>> {
      const queryId = generateQueryId();
      tracker.trackQuery(queryId, queryText);

      try {
        const result = await sql.unsafe<T[]>(queryText, params as ParameterOrJSON<never>[]);
        return {
          rows: result as T[],
          rowCount: result.length,
        };
      } finally {
        tracker.untrackQuery(queryId);
      }
    },

    async execute(queryText: string, params: unknown[] = []): Promise<{ rowCount: number }> {
      const queryId = generateQueryId();
      tracker.trackQuery(queryId, queryText);

      try {
        const result = await sql.unsafe(queryText, params as ParameterOrJSON<never>[]);
        return { rowCount: result.count ?? 0 };
      } finally {
        tracker.untrackQuery(queryId);
      }
    },

    async transaction<T>(fn: (trx: TransactionClient) => Promise<T>): Promise<T> {
      const txQueryId = generateQueryId();
      tracker.trackQuery(txQueryId, 'TRANSACTION');

      try {
        const result = await sql.begin(async (tx) => {
          const client: TransactionClient = {
            async query<R = Record<string, unknown>>(
              queryText: string,
              params: unknown[] = []
            ): Promise<QueryResult<R>> {
              const txResult = await tx.unsafe<R[]>(queryText, params as ParameterOrJSON<never>[]);
              return {
                rows: txResult as R[],
                rowCount: txResult.length,
              };
            },

            async execute(queryText: string, params: unknown[] = []): Promise<{ rowCount: number }> {
              const txResult = await tx.unsafe(queryText, params as ParameterOrJSON<never>[]);
              return { rowCount: txResult.count ?? 0 };
            },
          };

          return fn(client);
        });
        return result as T;
      } finally {
        tracker.untrackQuery(txQueryId);
      }
    },

    getActiveQueryCount(): number {
      return tracker.getActiveCount();
    },

    async drainAndClose(options: DrainOptions = {}): Promise<DrainResult> {
      const startTime = Date.now();
      const timeout = options.timeout ?? 30000;
      const forceCancelOnTimeout = options.forceCancelOnTimeout ?? true;

      draining = true;
      const initialActive = tracker.getActiveCount();

      options.onProgress?.({
        phase: 'draining',
        activeQueries: initialActive,
        completedQueries: 0,
        cancelledQueries: 0,
        elapsedMs: 0,
      });

      console.log(`[db-engine] Starting graceful shutdown with ${initialActive} active queries`);

      const { timedOut } = await tracker.startDrain(timeout);
      let cancelledQueries = 0;

      if (timedOut && forceCancelOnTimeout) {
        const activeQueries = tracker.getActiveQueries();
        console.log(`[db-engine] Timeout reached, cancelling ${activeQueries.length} queries`);

        options.onProgress?.({
          phase: 'cancelling',
          activeQueries: activeQueries.length,
          completedQueries: tracker.getStats().completed,
          cancelledQueries: 0,
          elapsedMs: Date.now() - startTime,
        });

        for (const query of activeQueries) {
          try {
            await sql.unsafe(
              `SELECT pg_cancel_backend(pid) FROM pg_stat_activity
               WHERE state = 'active' AND query LIKE $1`,
              [`%${query.query.slice(0, 50)}%`]
            );
            tracker.markCancelled(query.id);
            cancelledQueries++;
          } catch (e) {
            console.warn(`[db-engine] Failed to cancel query ${query.id}:`, e);
          }
        }
      }

      options.onProgress?.({
        phase: 'closing',
        activeQueries: 0,
        completedQueries: tracker.getStats().completed,
        cancelledQueries,
        elapsedMs: Date.now() - startTime,
      });

      console.log('[db-engine] Closing database connections');
      await sql.end();

      const result: DrainResult = {
        success: true,
        completedQueries: tracker.getStats().completed,
        cancelledQueries,
        elapsedMs: Date.now() - startTime,
      };

      options.onProgress?.({
        phase: 'complete',
        activeQueries: 0,
        completedQueries: result.completedQueries,
        cancelledQueries: result.cancelledQueries,
        elapsedMs: result.elapsedMs,
      });

      console.log(`[db-engine] Shutdown complete in ${result.elapsedMs}ms`);
      return result;
    },

    async close(): Promise<void> {
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
      }
      await sql.end();
    },

    async healthCheck(): Promise<HealthCheckResult> {
      return performHealthCheck();
    },

    getPoolStats(): PoolStats {
      return {
        totalConnections: maxConnections,
        activeConnections: (sql as unknown as { connections?: number }).connections ?? 0,
        idleConnections:
          maxConnections - ((sql as unknown as { connections?: number }).connections ?? 0),
        waitingRequests: 0,
        maxConnections,
      };
    },

    isHealthy(): boolean {
      return lastHealthCheck.healthy;
    },

    startHealthChecks(): void {
      if (healthCheckInterval) return;
      healthCheckInterval = setInterval(performHealthCheck, healthCheckConfig.intervalMs ?? 30000);
      performHealthCheck();
    },

    stopHealthChecks(): void {
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
      }
    },
  };
}
