import type { DialectName } from '../types/index.js';
import type { Driver, DriverConfig } from './types.js';
import { createPostgresDriver } from './postgresql.js';

export type { Driver, DriverConfig, TransactionClient } from './types.js';

export interface CreateDriverOptions extends DriverConfig {
  dialect?: DialectName;
}

export function detectDialect(connectionString: string): DialectName {
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

    default:
      throw new Error(`Unsupported dialect: ${dialect}`);
  }
}
