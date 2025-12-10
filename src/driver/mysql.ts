import type { Driver, DriverConfig, TransactionClient } from './types.js';
import type { QueryResult } from '../types/index.js';

export async function createMySQLDriver(config: DriverConfig): Promise<Driver> {
  const mysql = await import('mysql2/promise');

  const pool = mysql.createPool({
    uri: config.connectionString,
    waitForConnections: true,
    connectionLimit: config.max ?? 20,
    idleTimeout: (config.idleTimeout ?? 30) * 1000,
    connectTimeout: (config.connectTimeout ?? 10) * 1000,
  });

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
      await pool.end();
    },
  };
}
