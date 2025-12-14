import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createDriver } from '../driver/index.js';
import { MigrationRunner } from '../migrations/runner.js';
import { MigrationCollector } from '../modules/collector.js';
import { ModuleRegistry } from '../modules/registry.js';
import type { ModuleDefinition } from '../modules/types.js';
import { SchemaRegistry } from '../schema/registry.js';
import { generateTypes } from '../types/generator.js';
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

    const types = generateTypes(schemaMap);
    const outputPath = options.outputPath ?? config.typesOutputPath ?? './generated/types.ts';

    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, types, 'utf-8');

    console.log(`Generated types: ${outputPath}`);
    console.log(`  Schemas: ${Array.from(schemaMap.keys()).join(', ')}`);
  } finally {
    await driver.close();
  }
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
      migrationsToRun = direction === 'up'
        ? migrations.slice(0, options.steps)
        : migrations.slice(-options.steps).reverse();
    }

    for (const migration of migrationsToRun) {
      if (options.dryRun) {
        console.log(`[DRY RUN] Would ${direction === 'up' ? 'apply' : 'rollback'}: ${migration.version}__${migration.name} (module: ${migration.moduleName})`);
        continue;
      }

      const startTime = Date.now();
      try {
        const statements = direction === 'up' ? migration.up : migration.down;
        for (const sql of statements) {
          await driver.execute(sql);
        }
        console.log(`✓ ${migration.version}__${migration.name} (module: ${migration.moduleName}) (${Date.now() - startTime}ms)`);
      } catch (error) {
        console.error(`✗ ${migration.version}__${migration.name} (module: ${migration.moduleName}): ${error instanceof Error ? error.message : error}`);
        break;
      }
    }
  } finally {
    await driver.close();
  }
}
