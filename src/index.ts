export * from './types/index.js';

export * from './orm/index.js';

export {
  createDriver,
  detectDialect,
  createHealthCheckResult,
  getDefaultHealthCheckConfig,
  createPoolMonitor,
  isRetryableError,
  withRetry,
  createTimeoutPromise,
} from './driver/index.js';
export type {
  Driver,
  DriverConfig,
  TransactionClient,
  CreateDriverOptions,
  PoolStats,
  HealthCheckResult,
  HealthCheckConfig,
  PoolMonitorConfig,
  PoolMonitor,
  RetryConfig,
} from './driver/index.js';

export { SQLCompiler, createCompiler } from './compiler/index.js';
export type { CompilerOptions } from './compiler/index.js';

export {
  SelectBuilder,
  InsertBuilder,
  UpdateBuilder,
  DeleteBuilder,
  TableBuilder,
} from './query-builder/index.js';

export {
  MigrationRunner,
  createMigrationRunner,
} from './migrations/index.js';
export type { MigrationRunnerOptions, MigrationRunOptions } from './migrations/index.js';
export { getDialect, postgresDialect, mysqlDialect, sqliteDialect } from './migrations/index.js';
export type { Dialect } from './migrations/index.js';

export {
  ModuleRegistry,
  createModuleRegistry,
  MigrationCollector,
  createMigrationCollector,
} from './modules/index.js';
export type {
  ModuleRegistryOptions,
  MigrationCollectorOptions,
  ModuleDefinition,
  ModuleMigrationSource,
} from './modules/index.js';

export { SchemaRegistry, createSchemaRegistry } from './schema/index.js';
export type { SchemaRegistryOptions, RegisterSchemaOptions } from './schema/index.js';

export { generateTypes, generateSchemaFromDefinition } from './types/generator.js';
export type { TypeGeneratorOptions } from './types/generator.js';

export { DbClient, TransactionContext, createDbClient } from './client.js';
export type { DbClientOptions } from './client.js';

export {
  TenantContextError,
  validateTenantContext,
  validateTenantContextOrWarn,
} from './utils/tenant-validation.js';

export {
  Seeder,
  SeedRunner,
  createSeedRunner,
  SeedLoader,
  SeedTracker,
  SqlSeederAdapter,
} from './seed/index.js';
export type {
  SeedResult,
  SeederMetadata,
  SeederLogger,
  LoadedSeeder,
  SeedLoaderOptions,
  SeederConstructor,
  SeedRunnerOptions,
  SeedRunOptions,
  SeedRunResult,
  SeederResult,
  SeedTrackerOptions,
  SeedRecord,
} from './seed/index.js';

export {
  BranchManager,
  createBranchManager,
  SchemaDiffer,
  MigrationMerger,
  ConnectionManager,
  createConnectionManager,
  CleanupScheduler,
  createCleanupScheduler,
} from './branch/index.js';
export type {
  Branch,
  BranchStatus,
  CreateBranchOptions,
  SwitchBranchResult,
  SchemaDiff,
  TableDiff,
  ColumnDiff,
  IndexDiff,
  ConstraintDiff,
  Conflict,
  ConflictResolution,
  MergeOptions,
  MergeResult,
  ListBranchesFilter,
  CleanupOptions,
  CleanupResult,
  BranchManagerOptions,
  ConnectionManagerOptions,
  BranchConnection,
  CleanupSchedulerOptions,
  CleanupJob,
  MigrationMergerOptions,
  MigrationRecord,
} from './branch/index.js';

export async function createDb(options: {
  connectionString: string;
  migrationsPath?: string;
  tenantColumns?: { appId: string; organizationId: string };
  strictTenantMode?: boolean;
}) {
  const { createDriver } = await import('./driver/index.js');
  const { createDbClient } = await import('./client.js');

  const driver = await createDriver({ connectionString: options.connectionString });
  return createDbClient(driver, {
    migrationsPath: options.migrationsPath,
    tenantColumns: options.tenantColumns,
    strictTenantMode: options.strictTenantMode,
  });
}
