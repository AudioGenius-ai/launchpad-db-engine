import type { DialectName } from '../types/index.js';
import { createPostgresDriver } from './postgresql.js';
import type { Driver, DriverConfig } from './types.js';

export type { Driver, DriverConfig, TransactionClient } from './types.js';
export type { MongoDriver, MongoDriverConfig, MongoTransactionClient } from './mongodb.js';
export { createMongoDriver, isMongoDriver } from './mongodb.js';

export type {
  PoolStats,
  HealthCheckResult,
  HealthCheckConfig,
} from './health.js';
export {
  createHealthCheckResult,
  getDefaultHealthCheckConfig,
} from './health.js';

export type { PoolMonitorConfig, PoolMonitor } from './pool-monitor.js';
export { createPoolMonitor } from './pool-monitor.js';

export type { RetryConfig } from './retry.js';
export { isRetryableError, withRetry, createTimeoutPromise } from './retry.js';

export interface CreateDriverOptions extends DriverConfig {
  dialect?: DialectName;
  database?: string;
}

export function detectDialect(connectionString: string): DialectName {
  if (connectionString.startsWith('mongodb://') || connectionString.startsWith('mongodb+srv://')) {
    return 'mongodb';
  }
  if (connectionString.startsWith('postgres://') || connectionString.startsWith('postgresql://')) {
    return 'postgresql';
  }
  if (connectionString.startsWith('mysql://') || connectionString.startsWith('mariadb://')) {
    return 'mysql';
  }
  if (
    connectionString.startsWith('sqlite://') ||
    connectionString.startsWith('file://') ||
    connectionString.endsWith('.db') ||
    connectionString.endsWith('.sqlite') ||
    connectionString.endsWith('.sqlite3')
  ) {
    return 'sqlite';
  }
  throw new Error(`Unable to detect database dialect from connection string: ${connectionString}`);
}

export async function createDriver(options: CreateDriverOptions): Promise<Driver> {
  const dialect = options.dialect ?? detectDialect(options.connectionString);

  switch (dialect) {
    case 'postgresql':
      return createPostgresDriver(options);

    case 'mysql': {
      const { createMySQLDriver } = await import('./mysql.js');
      return createMySQLDriver(options);
    }

    case 'sqlite': {
      const { createSQLiteDriver } = await import('./sqlite.js');
      return createSQLiteDriver(options);
    }

    case 'mongodb': {
      const { createMongoDriver } = await import('./mongodb.js');
      return createMongoDriver(options);
    }

    default:
      throw new Error(`Unsupported dialect: ${dialect}`);
  }
}
