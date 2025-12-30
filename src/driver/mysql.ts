import type { PoolConnection } from 'mysql2/promise';
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

export async function createMySQLDriver(config: DriverConfig): Promise<Driver> {
  const mysql = await import('mysql2/promise');

  const pool = mysql.createPool({
    uri: config.connectionString,
    waitForConnections: true,
    connectionLimit: config.max ?? 20,
    idleTimeout: (config.idleTimeout ?? 30) * 1000,
    connectTimeout: (config.connectTimeout ?? 10) * 1000,
  });

  const maxConnections = config.max ?? 20;

  let lastHealthCheck: HealthCheckResult = createHealthCheckResult(true, 0);
  let healthCheckInterval: ReturnType<typeof setInterval> | null = null;

  const healthCheckConfig = getDefaultHealthCheckConfig(config.healthCheck);

  const tracker = new QueryTracker();
  let queryIdCounter = 0;
  let draining = false;

  const generateQueryId = () => `mysql-${++queryIdCounter}`;

  async function performHealthCheck(): Promise<HealthCheckResult> {
    const startTime = Date.now();
    try {
      const connection = (await Promise.race([
        pool.getConnection(),
        createTimeoutPromise<never>(healthCheckConfig.timeoutMs ?? 5000),
      ])) as PoolConnection;

      await connection.ping();
      connection.release();

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
    dialect: 'mysql',
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
        const [rows] = await pool.execute(queryText, params);
        const resultRows = Array.isArray(rows) ? rows : [];
        return {
          rows: resultRows as T[],
          rowCount: resultRows.length,
        };
      } finally {
        tracker.untrackQuery(queryId);
      }
    },

    async execute(queryText: string, params: unknown[] = []): Promise<{ rowCount: number }> {
      const queryId = generateQueryId();
      tracker.trackQuery(queryId, queryText);

      try {
        const [result] = await pool.execute(queryText, params);
        const affectedRows = (result as { affectedRows?: number }).affectedRows ?? 0;
        return { rowCount: affectedRows };
      } finally {
        tracker.untrackQuery(queryId);
      }
    },

    async transaction<T>(fn: (trx: TransactionClient) => Promise<T>): Promise<T> {
      const txQueryId = generateQueryId();
      tracker.trackQuery(txQueryId, 'TRANSACTION');

      const connection = await pool.getConnection();
      await connection.beginTransaction();

      try {
        const client: TransactionClient = {
          async query<R = Record<string, unknown>>(
            queryText: string,
            params: unknown[] = []
          ): Promise<QueryResult<R>> {
            const [rows] = await connection.execute(queryText, params);
            const resultRows = Array.isArray(rows) ? rows : [];
            return {
              rows: resultRows as R[],
              rowCount: resultRows.length,
            };
          },

          async execute(queryText: string, params: unknown[] = []): Promise<{ rowCount: number }> {
            const [result] = await connection.execute(queryText, params);
            const affectedRows = (result as { affectedRows?: number }).affectedRows ?? 0;
            return { rowCount: affectedRows };
          },
        };

        const result = await fn(client);
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
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
          if (query.backendPid) {
            try {
              await pool.execute(`KILL QUERY ${query.backendPid}`);
              tracker.markCancelled(query.id);
              cancelledQueries++;
            } catch (e) {
              console.warn(`[db-engine] Failed to cancel query ${query.id}:`, e);
            }
          } else {
            tracker.markCancelled(query.id);
            cancelledQueries++;
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
      await pool.end();

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
      await pool.end();
    },

    async healthCheck(): Promise<HealthCheckResult> {
      return performHealthCheck();
    },

    getPoolStats(): PoolStats {
      const poolState = (pool as unknown as { pool?: MySQLPoolState }).pool;
      return {
        totalConnections: poolState?._allConnections?.length ?? 0,
        activeConnections: poolState?._acquiringConnections?.length ?? 0,
        idleConnections: poolState?._freeConnections?.length ?? 0,
        waitingRequests: poolState?._connectionQueue?.length ?? 0,
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

interface MySQLPoolState {
  _allConnections?: unknown[];
  _acquiringConnections?: unknown[];
  _freeConnections?: unknown[];
  _connectionQueue?: unknown[];
}
