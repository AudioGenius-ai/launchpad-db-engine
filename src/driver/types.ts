import type { DialectName, QueryResult } from '../types/index.js';
import type { HealthCheckConfig, HealthCheckResult, PoolStats } from './health.js';

export interface DriverConfig {
  connectionString: string;
  max?: number;
  idleTimeout?: number;
  connectTimeout?: number;
  healthCheck?: HealthCheckConfig;
}

export interface Driver {
  readonly dialect: DialectName;
  readonly connectionString: string;

  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;

  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;

  transaction<T>(fn: (trx: TransactionClient) => Promise<T>): Promise<T>;

  close(): Promise<void>;

  healthCheck(): Promise<HealthCheckResult>;

  getPoolStats(): PoolStats;

  isHealthy(): boolean;

  startHealthChecks(): void;

  stopHealthChecks(): void;
}

export interface TransactionClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
}
