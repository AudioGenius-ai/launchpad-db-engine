import type { DialectName } from '../../types/index.js';
import { mysqlDialect } from './mysql.js';
import { postgresDialect } from './postgresql.js';
import { sqliteDialect } from './sqlite.js';
import type { Dialect } from './types.js';

export type { Dialect } from './types.js';

export function getDialect(name: DialectName): Dialect {
  switch (name) {
    case 'postgresql':
      return postgresDialect;
    case 'mysql':
      return mysqlDialect;
    case 'sqlite':
      return sqliteDialect;
    default:
      throw new Error(`Unsupported dialect: ${name}`);
  }
}

export { postgresDialect, mysqlDialect, sqliteDialect };
