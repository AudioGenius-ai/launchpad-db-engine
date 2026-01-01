import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createDriver } from '../driver/index.js';
import { getDialect } from '../migrations/dialects/index.js';
import { MigrationRunner } from '../migrations/runner.js';
import { MigrationCollector } from '../modules/collector.js';
import { ModuleRegistry } from '../modules/registry.js';
import type { ModuleDefinition } from '../modules/types.js';
import { createAuthHandler } from '../remote/auth.js';
import { createSchemaRemoteClient } from '../remote/client.js';
import {
  BreakingChangeError,
  UserCancelledError,
  createSchemaSyncService,
} from '../schema/index.js';
import { SchemaRegistry } from '../schema/registry.js';
import { generateTypes, generateZodSchemas } from '../types/generator.js';
import type { SchemaDefinition } from '../types/index.js';

export interface CliConfig {
  databaseUrl: string;
  migrationsPath: string;
  typesOutputPath?: string;
}

export async function runMigrations(
  config: CliConfig,
  options: {
    scope?: 'core' | 'template';
    templateKey?: string;
    steps?: number;
    toVersion?: number;
    dryRun?: boolean;
    direction: 'up' | 'down';
  }
): Promise<void> {
  const driver = await createDriver({ connectionString: config.databaseUrl });
  const runner = new MigrationRunner(driver, { migrationsPath: config.migrationsPath });

  try {
    const results =
      options.direction === 'up' ? await runner.up(options) : await runner.down(options);

    for (const result of results) {
      if (result.success) {
        console.log(`✓ ${result.version}__${result.name} (${result.duration}ms)`);
      } else {
        console.error(`✗ ${result.version}__${result.name}: ${result.error}`);
      }
    }

    if (results.length === 0) {
      console.log('No migrations to run');
    }
  } finally {
    await driver.close();
  }
}

export async function getMigrationStatus(
  config: CliConfig,
  options: {
    scope?: 'core' | 'template';
    templateKey?: string;
  }
): Promise<void> {
  const driver = await createDriver({ connectionString: config.databaseUrl });
  const runner = new MigrationRunner(driver, { migrationsPath: config.migrationsPath });

  try {
    const status = await runner.status(options);

    console.log('\n=== Migration Status ===\n');

    if (status.current !== null) {
      console.log(`Current version: ${status.current}`);
    } else {
      console.log('Current version: (none)');
    }

    console.log(`\nApplied (${status.applied.length}):`);
    for (const m of status.applied) {
      console.log(`  ✓ ${m.version}__${m.name} (${m.appliedAt.toISOString()})`);
    }

    console.log(`\nPending (${status.pending.length}):`);
    for (const m of status.pending) {
      console.log(`  ○ ${m.version}__${m.name}`);
    }
  } finally {
    await driver.close();
  }
}

export async function verifyMigrations(
  config: CliConfig,
  options: {
    scope?: 'core' | 'template';
    templateKey?: string;
  }
): Promise<void> {
  const driver = await createDriver({ connectionString: config.databaseUrl });
  const runner = new MigrationRunner(driver, { migrationsPath: config.migrationsPath });

  try {
    const result = await runner.verify(options);

    if (result.valid) {
      console.log('✓ All migrations are valid');
    } else {
      console.error('✗ Migration verification failed:');
      for (const issue of result.issues) {
        console.error(`  - ${issue}`);
      }
      process.exit(1);
    }
  } finally {
    await driver.close();
  }
}

export async function createMigration(
  config: CliConfig,
  options: {
    name: string;
    scope: 'core' | 'template';
    templateKey?: string;
  }
): Promise<void> {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:T.Z]/g, '')
    .slice(0, 14);
  const filename = `${timestamp}__${options.name}.sql`;

  const dirPath =
    options.scope === 'template' && options.templateKey
      ? join(config.migrationsPath, 'templates', options.templateKey)
      : join(config.migrationsPath, 'core');

  await mkdir(dirPath, { recursive: true });

  const filePath = join(dirPath, filename);
  const content = `-- ${filename}
-- Created: ${new Date().toISOString()}

-- up


-- down

`;

  await writeFile(filePath, content, 'utf-8');
  console.log(`Created migration: ${filePath}`);
}

export async function generateTypesFromRegistry(
  config: CliConfig,
  options: {
    appId?: string;
    outputPath?: string;
    includeZodSchemas?: boolean;
    includeInsertTypes?: boolean;
    includeUpdateTypes?: boolean;
  }
): Promise<void> {
  const driver = await createDriver({ connectionString: config.databaseUrl });
  const registry = new SchemaRegistry(driver);

  try {
    const schemas = await registry.listSchemas(options.appId);

    if (schemas.length === 0) {
      console.log('No schemas registered');
      return;
    }

    const schemaMap = new Map<string, SchemaDefinition>();
    for (const record of schemas) {
      schemaMap.set(record.schema_name, record.schema);
    }

    const generatorOptions = {
      includeInsertTypes: options.includeInsertTypes ?? true,
      includeUpdateTypes: options.includeUpdateTypes ?? true,
    };

    const types = generateTypes(schemaMap, generatorOptions);
    const outputPath = options.outputPath ?? config.typesOutputPath ?? './generated/types.ts';

    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, types, 'utf-8');

    console.log(`Generated types: ${outputPath}`);
    console.log(`  Schemas: ${Array.from(schemaMap.keys()).join(', ')}`);
    console.log(`  Insert types: ${generatorOptions.includeInsertTypes ? 'yes' : 'no'}`);
    console.log(`  Update types: ${generatorOptions.includeUpdateTypes ? 'yes' : 'no'}`);

    if (options.includeZodSchemas) {
      const zodSchemas = generateZodSchemas(schemaMap, generatorOptions);
      const zodOutputPath = outputPath.replace(/\.ts$/, '.zod.ts');

      await writeFile(zodOutputPath, zodSchemas, 'utf-8');

      console.log(`Generated Zod schemas: ${zodOutputPath}`);
    }
  } finally {
    await driver.close();
  }
}

export interface WatchOptions {
  appId?: string;
  outputPath?: string;
  debounceMs?: number;
  includeZodSchemas?: boolean;
  includeInsertTypes?: boolean;
  includeUpdateTypes?: boolean;
}

export async function watchAndGenerateTypes(
  config: CliConfig,
  options: WatchOptions
): Promise<void> {
  const { debounceMs = 500 } = options;
  const outputPath = options.outputPath ?? config.typesOutputPath ?? './generated/types.ts';

  let isShuttingDown = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let lastChecksum: string | null = null;
  let pollInterval: ReturnType<typeof setInterval> | null = null;

  const shutdown = async (driver?: { close: () => Promise<void> }) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log('\n\nShutting down watch mode...');

    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    if (pollInterval) {
      clearInterval(pollInterval);
    }
    if (driver) {
      await driver.close();
    }

    console.log('Watch mode stopped.');
    process.exit(0);
  };

  const computeChecksum = (schemas: Map<string, SchemaDefinition>): string => {
    const content = JSON.stringify(
      Array.from(schemas.entries()).sort((a, b) => a[0].localeCompare(b[0]))
    );
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return hash.toString(16);
  };

  const regenerateTypes = async (registry: SchemaRegistry, reason: string): Promise<void> => {
    try {
      const schemas = await registry.listSchemas(options.appId);

      if (schemas.length === 0) {
        console.log(`[${new Date().toLocaleTimeString()}] No schemas registered`);
        return;
      }

      const schemaMap = new Map<string, SchemaDefinition>();
      for (const record of schemas) {
        schemaMap.set(record.schema_name, record.schema);
      }

      const newChecksum = computeChecksum(schemaMap);

      if (newChecksum === lastChecksum) {
        return;
      }

      lastChecksum = newChecksum;

      const generatorOptions = {
        includeInsertTypes: options.includeInsertTypes ?? true,
        includeUpdateTypes: options.includeUpdateTypes ?? true,
      };

      const types = generateTypes(schemaMap, generatorOptions);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, types, 'utf-8');

      const schemaNames = Array.from(schemaMap.keys()).join(', ');
      console.log(
        `[${new Date().toLocaleTimeString()}] ${reason} - Regenerated types (${schemaNames})`
      );

      if (options.includeZodSchemas) {
        const zodSchemas = generateZodSchemas(schemaMap, generatorOptions);
        const zodOutputPath = outputPath.replace(/\.ts$/, '.zod.ts');
        await writeFile(zodOutputPath, zodSchemas, 'utf-8');
        console.log(`[${new Date().toLocaleTimeString()}] ${reason} - Regenerated Zod schemas`);
      }
    } catch (error) {
      console.error(
        `[${new Date().toLocaleTimeString()}] Error regenerating types:`,
        error instanceof Error ? error.message : error
      );
    }
  };

  const driver = await createDriver({ connectionString: config.databaseUrl });
  const registry = new SchemaRegistry(driver);

  process.on('SIGINT', () => shutdown(driver));
  process.on('SIGTERM', () => shutdown(driver));

  console.log('Watching for schema changes...');
  console.log(`  Output: ${outputPath}`);
  console.log(`  Debounce: ${debounceMs}ms`);
  console.log('  Press Ctrl+C to stop\n');

  await regenerateTypes(registry, 'Initial generation');

  const debouncedRegenerate = (reason: string) => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(async () => {
      await regenerateTypes(registry, reason);
    }, debounceMs);
  };

  pollInterval = setInterval(() => {
    if (!isShuttingDown) {
      debouncedRegenerate('Schema change detected');
    }
  }, 1000);

  await new Promise<void>(() => {});
}

export async function registerSchema(
  config: CliConfig,
  options: {
    appId: string;
    schemaName: string;
    version: string;
    schemaPath: string;
  }
): Promise<void> {
  const driver = await createDriver({ connectionString: config.databaseUrl });
  const registry = new SchemaRegistry(driver);

  try {
    // Verify file exists by reading it
    await readFile(options.schemaPath, 'utf-8');
    const schemaModule = await import(options.schemaPath);
    const schema: SchemaDefinition = schemaModule.schema || schemaModule.default;

    if (!schema?.tables) {
      throw new Error('Invalid schema file. Must export a SchemaDefinition with tables property.');
    }

    const results = await registry.register({
      appId: options.appId,
      schemaName: options.schemaName,
      version: options.version,
      schema,
    });

    if (results.length === 0) {
      console.log('Schema is up to date');
    } else {
      console.log(`Applied ${results.length} schema changes:`);
      for (const result of results) {
        if (result.success) {
          console.log(`  ✓ ${result.name}`);
        } else {
          console.error(`  ✗ ${result.name}: ${result.error}`);
        }
      }
    }
  } finally {
    await driver.close();
  }
}

export async function listModules(config: CliConfig): Promise<void> {
  const driver = await createDriver({ connectionString: config.databaseUrl });
  const registry = new ModuleRegistry(driver);

  try {
    const modules = await registry.list();

    console.log('\n=== Registered Modules ===\n');

    if (modules.length === 0) {
      console.log('No modules registered');
      return;
    }

    for (const mod of modules) {
      console.log(`${mod.name} (v${mod.version})`);
      console.log(`  Display name: ${mod.displayName}`);
      if (mod.description) {
        console.log(`  Description: ${mod.description}`);
      }
      console.log(`  Migration prefix: ${mod.migrationPrefix}`);
      if (mod.dependencies?.length) {
        console.log(`  Dependencies: ${mod.dependencies.join(', ')}`);
      }
      console.log();
    }
  } finally {
    await driver.close();
  }
}

export async function registerModule(
  config: CliConfig,
  options: {
    name: string;
    displayName: string;
    version: string;
    migrationPrefix: string;
    description?: string;
    dependencies?: string[];
  }
): Promise<void> {
  const driver = await createDriver({ connectionString: config.databaseUrl });
  const registry = new ModuleRegistry(driver);

  try {
    const module: ModuleDefinition = {
      name: options.name,
      displayName: options.displayName,
      version: options.version,
      migrationPrefix: options.migrationPrefix,
      description: options.description,
      dependencies: options.dependencies,
    };

    await registry.register(module);
    console.log(`✓ Registered module: ${options.name} (v${options.version})`);
  } finally {
    await driver.close();
  }
}

export async function runModuleMigrations(
  config: CliConfig,
  options: {
    modulesPath: string;
    dryRun?: boolean;
    direction?: 'up' | 'down';
    steps?: number;
  }
): Promise<void> {
  const driver = await createDriver({ connectionString: config.databaseUrl });
  const runner = new MigrationRunner(driver, { migrationsPath: config.migrationsPath });
  const collector = new MigrationCollector();

  try {
    const sources = await collector.discoverFromDirectory(options.modulesPath);

    if (sources.length === 0) {
      console.log('No module migrations found');
      return;
    }

    console.log(`Found ${sources.length} module(s):`);
    for (const source of sources) {
      console.log(`  - ${source.moduleName}`);
    }
    console.log();

    const migrations = await collector.collect(sources);

    if (migrations.length === 0) {
      console.log('No migrations to run');
      return;
    }

    await runner.ensureMigrationsTable();

    const direction = options.direction ?? 'up';
    let migrationsToRun = migrations;

    if (options.steps) {
      migrationsToRun =
        direction === 'up'
          ? migrations.slice(0, options.steps)
          : migrations.slice(-options.steps).reverse();
    }

    for (const migration of migrationsToRun) {
      if (options.dryRun) {
        console.log(
          `[DRY RUN] Would ${direction === 'up' ? 'apply' : 'rollback'}: ${migration.version}__${migration.name} (module: ${migration.moduleName})`
        );
        continue;
      }

      const startTime = Date.now();
      try {
        const statements = direction === 'up' ? migration.up : migration.down;
        for (const sql of statements) {
          await driver.execute(sql);
        }
        console.log(
          `✓ ${migration.version}__${migration.name} (module: ${migration.moduleName}) (${Date.now() - startTime}ms)`
        );
      } catch (error) {
        console.error(
          `✗ ${migration.version}__${migration.name} (module: ${migration.moduleName}): ${error instanceof Error ? error.message : error}`
        );
        break;
      }
    }
  } finally {
    await driver.close();
  }
}

export interface SyncConfig {
  databaseUrl: string;
  apiUrl: string;
  projectId: string;
  appId: string;
  migrationsPath?: string;
}

export async function pullSchema(
  config: SyncConfig,
  options: {
    environment?: string;
    dryRun?: boolean;
    force?: boolean;
  } = {}
): Promise<void> {
  const driver = await createDriver({ connectionString: config.databaseUrl });
  const dialect = getDialect(driver.dialect);

  const authHandler = createAuthHandler();
  let authToken: string;

  try {
    authToken = await authHandler.getToken();
  } catch (error) {
    console.error('Authentication required. Run `launchpad login` first.');
    await driver.close();
    process.exit(1);
  }

  const remoteClient = createSchemaRemoteClient({
    apiUrl: config.apiUrl,
    projectId: config.projectId,
    authToken,
  });

  const syncService = createSchemaSyncService(driver, dialect, remoteClient, {
    appId: config.appId,
    migrationsPath: config.migrationsPath,
  });

  try {
    const result = await syncService.pull({
      environment: options.environment,
      dryRun: options.dryRun,
      force: options.force,
    });

    if (result.applied) {
      console.log(`\n✓ Applied ${result.diff.changes.length} change(s)`);
    } else if (!result.diff.hasDifferences) {
      console.log('\n✓ Local schema is already up to date');
    }
  } catch (error) {
    if (error instanceof BreakingChangeError) {
      console.error(`\n✗ ${error.message}`);
      console.error('\nBreaking changes detected:');
      for (const change of error.changes) {
        console.error(`  - ${change.description}`);
      }
      process.exit(1);
    }
    throw error;
  } finally {
    await driver.close();
  }
}

export async function pushSchema(
  config: SyncConfig,
  options: {
    environment?: string;
    dryRun?: boolean;
    force?: boolean;
  } = {}
): Promise<void> {
  const driver = await createDriver({ connectionString: config.databaseUrl });
  const dialect = getDialect(driver.dialect);

  const authHandler = createAuthHandler();
  let authToken: string;

  try {
    authToken = await authHandler.getToken();
  } catch (error) {
    console.error('Authentication required. Run `launchpad login` first.');
    await driver.close();
    process.exit(1);
  }

  const remoteClient = createSchemaRemoteClient({
    apiUrl: config.apiUrl,
    projectId: config.projectId,
    authToken,
  });

  const syncService = createSchemaSyncService(driver, dialect, remoteClient, {
    appId: config.appId,
    migrationsPath: config.migrationsPath,
  });

  try {
    const result = await syncService.push({
      environment: options.environment,
      dryRun: options.dryRun,
      force: options.force,
    });

    if (result.applied) {
      console.log(`\n✓ Pushed ${result.diff.changes.length} change(s) to remote`);
    } else if (!result.diff.hasDifferences) {
      console.log('\n✓ Remote schema is already up to date');
    }
  } catch (error) {
    if (error instanceof BreakingChangeError) {
      console.error(`\n✗ ${error.message}`);
      console.error('\nBreaking changes detected:');
      for (const change of error.changes) {
        console.error(`  - ${change.description}`);
      }
      process.exit(1);
    }
    if (error instanceof UserCancelledError) {
      console.error(`\n${error.message}`);
      process.exit(1);
    }
    throw error;
  } finally {
    await driver.close();
  }
}

export async function diffSchema(
  config: SyncConfig,
  options: {
    environment?: string;
    outputFormat?: 'text' | 'json' | 'sql';
  } = {}
): Promise<void> {
  const driver = await createDriver({ connectionString: config.databaseUrl });
  const dialect = getDialect(driver.dialect);

  const authHandler = createAuthHandler();
  let authToken: string;

  try {
    authToken = await authHandler.getToken();
  } catch (error) {
    console.error('Authentication required. Run `launchpad login` first.');
    await driver.close();
    process.exit(1);
  }

  const remoteClient = createSchemaRemoteClient({
    apiUrl: config.apiUrl,
    projectId: config.projectId,
    authToken,
  });

  const syncService = createSchemaSyncService(driver, dialect, remoteClient, {
    appId: config.appId,
    migrationsPath: config.migrationsPath,
  });

  try {
    const diff = await syncService.diff({
      environment: options.environment,
    });

    const output = syncService.formatDiff(diff, options.outputFormat ?? 'text');
    console.log(output);

    if (diff.hasDifferences) {
      process.exit(1);
    }
  } finally {
    await driver.close();
  }
}

export async function getSyncStatus(config: SyncConfig): Promise<void> {
  const driver = await createDriver({ connectionString: config.databaseUrl });
  const dialect = getDialect(driver.dialect);

  const authHandler = createAuthHandler();
  let authToken: string;

  try {
    authToken = await authHandler.getToken();
  } catch (error) {
    console.error('Authentication required. Run `launchpad login` first.');
    await driver.close();
    process.exit(1);
  }

  const remoteClient = createSchemaRemoteClient({
    apiUrl: config.apiUrl,
    projectId: config.projectId,
    authToken,
  });

  const syncService = createSchemaSyncService(driver, dialect, remoteClient, {
    appId: config.appId,
    migrationsPath: config.migrationsPath,
  });

  try {
    const status = await syncService.getSyncStatus();

    if (!status) {
      console.log('No sync history found. Run `db pull` or `db push` to sync.');
      return;
    }

    console.log('\n=== Sync Status ===\n');
    console.log(`Status: ${status.syncStatus}`);
    console.log(`Last sync: ${status.lastSyncAt?.toISOString() ?? 'Never'}`);
    console.log(`Direction: ${status.lastSyncDirection ?? 'N/A'}`);
    console.log(`Local checksum: ${status.localChecksum ?? 'N/A'}`);
    console.log(`Remote checksum: ${status.remoteChecksum ?? 'N/A'}`);

    if (status.syncStatus === 'conflict') {
      console.log('\n⚠️  Conflict detected! Manual resolution required.');
    }
  } finally {
    await driver.close();
  }
}
