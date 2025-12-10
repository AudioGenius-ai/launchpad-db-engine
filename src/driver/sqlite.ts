import type { Driver, DriverConfig, TransactionClient } from './types.js';
import type { QueryResult } from '../types/index.js';

export async function createSQLiteDriver(config: DriverConfig): Promise<Driver> {
  const Database = (await import('better-sqlite3')).default;

  const dbPath = config.connectionString.replace('sqlite://', '').replace('file://', '');
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

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

      const transaction = db.transaction(async () => {
        return await fn(client);
      });

      return transaction() as T;
    },

    async close(): Promise<void> {
      db.close();
    },
  };
}
