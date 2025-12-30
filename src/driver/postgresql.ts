import postgres, { type ParameterOrJSON } from 'postgres';
import type { QueryResult } from '../types/index.js';
import {
  type HealthCheckResult,
  type PoolStats,
  createHealthCheckResult,
  getDefaultHealthCheckConfig,
} from './health.js';
import { createTimeoutPromise } from './retry.js';
import type { Driver, DriverConfig, TransactionClient } from './types.js';

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

    async query<T = Record<string, unknown>>(
      queryText: string,
      params: unknown[] = []
    ): Promise<QueryResult<T>> {
      const result = await sql.unsafe<T[]>(queryText, params as ParameterOrJSON<never>[]);
      return {
        rows: result as T[],
        rowCount: result.length,
      };
    },

    async execute(queryText: string, params: unknown[] = []): Promise<{ rowCount: number }> {
      const result = await sql.unsafe(queryText, params as ParameterOrJSON<never>[]);
      return { rowCount: result.count ?? 0 };
    },

    async transaction<T>(fn: (trx: TransactionClient) => Promise<T>): Promise<T> {
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
