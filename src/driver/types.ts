import type { DialectName, QueryResult } from '../types/index.js';
import type { HealthCheckConfig, HealthCheckResult, PoolStats } from './health.js';

export interface DriverConfig {
  connectionString: string;
  max?: number;
  idleTimeout?: number;
  connectTimeout?: number;
  healthCheck?: HealthCheckConfig;
}

export type DrainPhase = 'draining' | 'cancelling' | 'closing' | 'complete';

export interface DrainOptions {
  timeout?: number;
  onProgress?: (progress: DrainProgress) => void;
  forceCancelOnTimeout?: boolean;
}

export interface DrainProgress {
  phase: DrainPhase;
  activeQueries: number;
  completedQueries: number;
  cancelledQueries: number;
  elapsedMs: number;
}

export interface DrainResult {
  success: boolean;
  completedQueries: number;
  cancelledQueries: number;
  elapsedMs: number;
  error?: Error;
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

  drainAndClose(options?: DrainOptions): Promise<DrainResult>;

  getActiveQueryCount(): number;

  readonly isDraining: boolean;
}

export interface TransactionClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
}
