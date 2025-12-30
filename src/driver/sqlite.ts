import type { QueryResult } from '../types/index.js';
import {
  type HealthCheckResult,
  type PoolStats,
  createHealthCheckResult,
  getDefaultHealthCheckConfig,
} from './health.js';
import type { Driver, DriverConfig, TransactionClient } from './types.js';

export async function createSQLiteDriver(config: DriverConfig): Promise<Driver> {
  const Database = (await import('better-sqlite3')).default;

  const dbPath = config.connectionString.replace('sqlite://', '').replace('file://', '');
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  let lastHealthCheck: HealthCheckResult = createHealthCheckResult(true, 0);
  let healthCheckInterval: ReturnType<typeof setInterval> | null = null;

  const healthCheckConfig = getDefaultHealthCheckConfig(config.healthCheck);

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

    async query<T = Record<string, unknown>>(
      queryText: string,
      params: unknown[] = []
    ): Promise<QueryResult<T>> {
      const stmt = db.prepare(queryText);
      const rows = stmt.all(...params) as T[];
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

    async transaction<T>(fn: (trx: TransactionClient) => Promise<T>): Promise<T> {
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
      }
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
