import postgres, { type ParameterOrJSON } from 'postgres';
import type { QueryResult } from '../types/index.js';
import type { Driver, DriverConfig, TransactionClient } from './types.js';

export function createPostgresDriver(config: DriverConfig): Driver {
  const sql = postgres(config.connectionString, {
    max: config.max ?? 20,
    idle_timeout: config.idleTimeout ?? 30,
    connect_timeout: config.connectTimeout ?? 10,
    prepare: true,
  });

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
      await sql.end();
    },
  };
}
