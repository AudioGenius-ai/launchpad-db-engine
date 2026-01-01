import type { Driver, TransactionClient } from '../driver/types.js';
import type { QueryResult } from '../types/index.js';

export interface SeedResult {
  count: number;
  details?: Record<string, number>;
}

export interface SeederMetadata {
  name: string;
  order: number;
  dependencies: string[];
  version: number;
}

export interface SeederLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const defaultLogger: SeederLogger = {
  info: (msg) => console.log(msg),
  warn: (msg) => console.warn(msg),
  error: (msg) => console.error(msg),
};

export abstract class Seeder {
  static order = 0;
  static dependencies: string[] = [];
  static version = 1;

  protected driver: Driver;
  protected logger: SeederLogger;

  constructor(driver: Driver, logger?: SeederLogger) {
    this.driver = driver;
    this.logger = logger ?? defaultLogger;
  }

  abstract run(): Promise<SeedResult>;

  async rollback(): Promise<void> {
    throw new Error('Rollback not implemented');
  }

  get metadata(): SeederMetadata {
    const ctor = this.constructor as typeof Seeder;
    return {
      name: this.constructor.name.replace(/Seeder$/, '').toLowerCase(),
      order: ctor.order,
      dependencies: ctor.dependencies,
      version: ctor.version,
    };
  }

  protected async query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    return this.driver.query<T>(sql, params);
  }

  protected async execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }> {
    return this.driver.execute(sql, params);
  }

  protected async transaction<T>(fn: (trx: TransactionClient) => Promise<T>): Promise<T> {
    return this.driver.transaction(fn);
  }
}
