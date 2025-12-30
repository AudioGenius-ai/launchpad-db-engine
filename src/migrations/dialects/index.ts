import type { DialectName } from '../../types/index.js';
import { mysqlDialect } from './mysql.js';
import { postgresDialect } from './postgresql.js';
import { sqliteDialect } from './sqlite.js';
import type { Dialect } from './types.js';

export type { Dialect } from './types.js';
export { mongoDialect, executeMongoMigration } from './mongodb.js';
export type { MongoDialect, MongoMigrationOperation } from './mongodb.js';

export function getDialect(name: DialectName): Dialect {
  switch (name) {
    case 'postgresql':
      return postgresDialect;
    case 'mysql':
      return mysqlDialect;
    case 'sqlite':
      return sqliteDialect;
    case 'mongodb':
      throw new Error(
        'MongoDB uses a different dialect interface. Use mongoDialect and executeMongoMigration instead.'
      );
    default:
      throw new Error(`Unsupported dialect: ${name}`);
  }
}

export { postgresDialect, mysqlDialect, sqliteDialect };
