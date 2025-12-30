import type { QueryResult } from '../types/index.js';
import {
  type HealthCheckResult,
  type PoolStats,
  createHealthCheckResult,
  getDefaultHealthCheckConfig,
} from './health.js';
import { QueryTracker } from './query-tracker.js';
import type { Driver, DriverConfig, DrainOptions, DrainResult, TransactionClient } from './types.js';

export async function createSQLiteDriver(config: DriverConfig): Promise<Driver> {
  const Database = (await import('better-sqlite3')).default;

  const dbPath = config.connectionString.replace('sqlite://', '').replace('file://', '');
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  let lastHealthCheck: HealthCheckResult = createHealthCheckResult(true, 0);
  let healthCheckInterval: ReturnType<typeof setInterval> | null = null;

  const healthCheckConfig = getDefaultHealthCheckConfig(config.healthCheck);

  const tracker = new QueryTracker();
  let queryIdCounter = 0;
  let draining = false;

  const generateQueryId = () => `sqlite-${++queryIdCounter}`;

  function performHealthCheck(): HealthCheckResult {
    const startTime = Date.now();
    try {
      db.prepare('SELECT 1').get();

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
    dialect: 'sqlite',
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
        const stmt = db.prepare(queryText);
        const rows = stmt.all(...params) as T[];
        return {
          rows,
          rowCount: rows.length,
        };
      } finally {
        tracker.untrackQuery(queryId);
      }
    },

    async execute(queryText: string, params: unknown[] = []): Promise<{ rowCount: number }> {
      const queryId = generateQueryId();
      tracker.trackQuery(queryId, queryText);

      try {
        const stmt = db.prepare(queryText);
        const result = stmt.run(...params);
        return { rowCount: result.changes };
      } finally {
        tracker.untrackQuery(queryId);
      }
    },

    async transaction<T>(fn: (trx: TransactionClient) => Promise<T>): Promise<T> {
      const txQueryId = generateQueryId();
      tracker.trackQuery(txQueryId, 'TRANSACTION');

      const client: TransactionClient = {
        async query<R = Record<string, unknown>>(
          queryText: string,
          params: unknown[] = []
        ): Promise<QueryResult<R>> {
          const stmt = db.prepare(queryText);
          const rows = stmt.all(...params) as R[];
          return {
            rows,
            rowCount: rows.length,
          };
        },

        async execute(queryText: string, params: unknown[] = []): Promise<{ rowCount: number }> {
          const stmt = db.prepare(queryText);
          const result = stmt.run(...params);
          return { rowCount: result.changes };
        },
      };

      let result: T;
      let committed = false;

      db.prepare('BEGIN IMMEDIATE').run();
      try {
        result = await fn(client);
        db.prepare('COMMIT').run();
        committed = true;
        return result;
      } catch (error) {
        if (!committed) {
          db.prepare('ROLLBACK').run();
        }
        throw error;
      } finally {
        tracker.untrackQuery(txQueryId);
      }
    },

    getActiveQueryCount(): number {
      return tracker.getActiveCount();
    },

    async drainAndClose(options: DrainOptions = {}): Promise<DrainResult> {
      const startTime = Date.now();

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

      options.onProgress?.({
        phase: 'closing',
        activeQueries: 0,
        completedQueries: tracker.getStats().completed,
        cancelledQueries: 0,
        elapsedMs: Date.now() - startTime,
      });

      console.log('[db-engine] Closing database connection');
      db.close();

      const result: DrainResult = {
        success: true,
        completedQueries: tracker.getStats().completed,
        cancelledQueries: 0,
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
      db.close();
    },

    async healthCheck(): Promise<HealthCheckResult> {
      return performHealthCheck();
    },

    getPoolStats(): PoolStats {
      return {
        totalConnections: 1,
        activeConnections: lastHealthCheck.healthy ? 1 : 0,
        idleConnections: 0,
        waitingRequests: 0,
        maxConnections: 1,
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
