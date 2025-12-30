import { MongoCompiler, SQLCompiler } from './compiler/index.js';
import { isMongoDriver } from './driver/mongodb.js';
import type { Driver, TransactionClient } from './driver/types.js';
import { type MigrationRunOptions, MigrationRunner } from './migrations/runner.js';
import { MongoTableBuilder, TableBuilder } from './query-builder/index.js';
import { type RegisterSchemaOptions, SchemaRegistry } from './schema/registry.js';
import type { QueryResult, TenantContext } from './types/index.js';
import { validateTenantContext } from './utils/tenant-validation.js';

export interface DbClientOptions {
  migrationsPath?: string;
  tenantColumns?: {
    appId: string;
    organizationId: string;
  };
  strictTenantMode?: boolean;
}

export class DbClient {
  private driver: Driver;
  private compiler: SQLCompiler | MongoCompiler;
  private migrationRunner?: MigrationRunner;
  private schemaRegistry: SchemaRegistry;
  private strictTenantMode: boolean;

  constructor(driver: Driver, options: DbClientOptions = {}) {
    this.driver = driver;

    if (driver.dialect === 'mongodb') {
      this.compiler = new MongoCompiler({
        injectTenant: true,
        tenantColumns: options.tenantColumns,
      });
    } else {
      this.compiler = new SQLCompiler({
        dialect: driver.dialect,
        injectTenant: true,
        tenantColumns: options.tenantColumns,
      });
    }

    if (options.migrationsPath && driver.dialect !== 'mongodb') {
      this.migrationRunner = new MigrationRunner(driver, {
        migrationsPath: options.migrationsPath,
      });
    }

    this.schemaRegistry = new SchemaRegistry(driver);
    this.strictTenantMode = options.strictTenantMode ?? true;
  }

  table<T = Record<string, unknown>>(
    name: string,
    ctx: TenantContext
  ): TableBuilder<T> | MongoTableBuilder<T> {
    if (this.strictTenantMode) {
      validateTenantContext(ctx, name);
    }
    if (isMongoDriver(this.driver)) {
      return new MongoTableBuilder<T>(this.driver, this.compiler as MongoCompiler, name, ctx, true);
    }
    return new TableBuilder<T>(this.driver, this.compiler as SQLCompiler, name, ctx, true);
  }

  tableWithoutTenant<T = Record<string, unknown>>(
    name: string
  ): TableBuilder<T> | MongoTableBuilder<T> {
    if (isMongoDriver(this.driver)) {
      const compilerWithoutTenant = new MongoCompiler({ injectTenant: false });
      return new MongoTableBuilder<T>(this.driver, compilerWithoutTenant, name, undefined, false);
    }
    const compilerWithoutTenant = new SQLCompiler({
      dialect: this.driver.dialect,
      injectTenant: false,
    });
    return new TableBuilder<T>(this.driver, compilerWithoutTenant, name, undefined, false);
  }

  async transaction<T>(
    ctx: TenantContext,
    fn: (trx: TransactionContext) => Promise<T>
  ): Promise<T> {
    return this.driver.transaction(async (trxClient) => {
      if (this.driver.dialect === 'postgresql') {
        await trxClient.execute(`SELECT set_config('app.current_app_id', $1, true)`, [ctx.appId]);
        await trxClient.execute(`SELECT set_config('app.current_org_id', $1, true)`, [
          ctx.organizationId,
        ]);
      }

      const trxContext = new TransactionContext(trxClient, this.compiler, ctx);
      return fn(trxContext);
    });
  }

  async raw<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    return this.driver.query<T>(sql, params);
  }

  async rawWithTenant<T = Record<string, unknown>>(
    ctx: TenantContext,
    sql: string,
    params: unknown[] = []
  ): Promise<QueryResult<T>> {
    const tenantParams = [ctx.appId, ctx.organizationId, ...params];
    return this.driver.query<T>(sql, tenantParams);
  }

  async execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }> {
    return this.driver.execute(sql, params);
  }

  get migrations() {
    if (!this.migrationRunner) {
      throw new Error('Migrations path not configured. Pass migrationsPath to DbClient options.');
    }
    return {
      up: (options?: MigrationRunOptions) => this.migrationRunner!.up(options),
      down: (options?: MigrationRunOptions) => this.migrationRunner!.down(options),
      status: (options?: MigrationRunOptions) => this.migrationRunner!.status(options),
      verify: (options?: MigrationRunOptions) => this.migrationRunner!.verify(options),
    };
  }

  get schema() {
    return {
      register: (options: RegisterSchemaOptions) => this.schemaRegistry.register(options),
      get: (appId: string, schemaName: string) =>
        this.schemaRegistry.getCurrentSchema(appId, schemaName),
      list: (appId?: string) => this.schemaRegistry.listSchemas(appId),
    };
  }

  get dialect() {
    return this.driver.dialect;
  }

  async close(): Promise<void> {
    return this.driver.close();
  }
}

export class TransactionContext {
  private client: TransactionClient;
  private compiler: SQLCompiler | MongoCompiler;
  private ctx: TenantContext;

  constructor(
    client: TransactionClient,
    compiler: SQLCompiler | MongoCompiler,
    ctx: TenantContext
  ) {
    this.client = client;
    this.compiler = compiler;
    this.ctx = ctx;
  }

  table<T = Record<string, unknown>>(name: string): TableBuilder<T> {
    return new TableBuilder<T>(this.client, this.compiler as SQLCompiler, name, this.ctx, true);
  }

  async raw<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    return this.client.query<T>(sql, params);
  }

  async execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }> {
    return this.client.execute(sql, params);
  }
}

export function createDbClient(driver: Driver, options?: DbClientOptions): DbClient {
  return new DbClient(driver, options);
}
