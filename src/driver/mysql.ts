import type { PoolConnection } from 'mysql2/promise';
import type { QueryResult } from '../types/index.js';
import {
  type HealthCheckResult,
  type PoolStats,
  createHealthCheckResult,
  getDefaultHealthCheckConfig,
} from './health.js';
import { createTimeoutPromise } from './retry.js';
import type { Driver, DriverConfig, TransactionClient } from './types.js';

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

    async query<T = Record<string, unknown>>(
      queryText: string,
      params: unknown[] = []
    ): Promise<QueryResult<T>> {
      const [rows] = await pool.execute(queryText, params);
      const resultRows = Array.isArray(rows) ? rows : [];
      return {
        rows: resultRows as T[],
        rowCount: resultRows.length,
      };
    },

    async execute(queryText: string, params: unknown[] = []): Promise<{ rowCount: number }> {
      const [result] = await pool.execute(queryText, params);
      const affectedRows = (result as { affectedRows?: number }).affectedRows ?? 0;
      return { rowCount: affectedRows };
    },

    async transaction<T>(fn: (trx: TransactionClient) => Promise<T>): Promise<T> {
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
      }
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
