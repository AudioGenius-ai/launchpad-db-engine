#!/usr/bin/env node

import { parseArgs } from 'node:util';
import {
  createMigration,
  generateTypesFromRegistry,
  getMigrationStatus,
  listModules,
  registerModule,
  registerSchema,
  runMigrations,
  runModuleMigrations,
  verifyMigrations,
} from './index.js';

interface ParsedArgs {
  'db-url'?: string;
  migrations: string;
  scope?: string;
  'template-key'?: string;
  steps?: string;
  'to-version'?: string;
  'dry-run'?: boolean;
  name?: string;
  'app-id'?: string;
  output?: string;
  hooks?: string;
  'no-hooks'?: boolean;
  version?: string;
  file?: string;
  'display-name'?: string;
  'migration-prefix'?: string;
  description?: string;
  dependencies?: string;
  'modules-path'?: string;
}

interface Config {
  databaseUrl: string;
  migrationsPath: string;
  typesOutputPath?: string;
}

type CommandHandler = (config: Config, args: ParsedArgs) => Promise<void>;

function printHelp(): void {
  console.log(`
launchpad-db - Database engine CLI

Usage: launchpad-db <command> [options]

Commands:
  migrate:up       Run pending migrations
  migrate:down     Rollback migrations
  migrate:status   Show migration status
  migrate:verify   Verify migration checksums
  migrate:create   Create a new migration file
  migrate:modules  Run module migrations
  module:list      List registered modules
  module:register  Register a module
  types:generate   Generate TypeScript types and React Query hooks from schemas
                   - Generates Row, Insert, and Update types per table
                   - Generates React Query hooks for each table
                   - Hooks integrate with @launchpad/db SDK
  schema:register  Register a schema from a file

Types Generate Options:
  --output         Types output file path (default: ./generated/types.ts)
  --hooks          Hooks output file path (default: ./generated/hooks.ts)
  --app-id         Filter schemas by app ID
  --no-hooks       Skip hooks generation (types only)

Global Options:
  --db-url         Database connection string (or set DATABASE_URL env var)
  --migrations     Path to migrations directory (default: ./migrations)
  --help           Show this help message

Module Options:
  --modules-path   Path to modules directory (default: ./migrations/modules)
  --name           Module name
  --display-name   Module display name
  --version        Module version
  --migration-prefix  Prefix for module migrations
  --description    Module description
  --dependencies   Comma-separated list of module dependencies

Examples:
  launchpad-db migrate:up
  launchpad-db migrate:up --scope template --template-key crm
  launchpad-db migrate:down --steps 1
  launchpad-db migrate:create --name add_users --scope core
  launchpad-db migrate:modules --modules-path ./migrations/modules
  launchpad-db module:list
  launchpad-db module:register --name workflows --display-name "Workflows Engine" --version 1.0.0 --migration-prefix workflows
  launchpad-db types:generate --output ./src/types.ts
  launchpad-db types:generate --output ./src/types.ts --hooks ./src/hooks.ts
  launchpad-db types:generate --output ./src/types.ts --no-hooks
  launchpad-db schema:register --app-id myapp --name crm --version 1.0.0 --file ./schema.ts
`);
}

function parseIntOrUndefined(value: string | undefined): number | undefined {
  return value ? Number.parseInt(value, 10) : undefined;
}

async function handleMigrateUp(config: Config, args: ParsedArgs): Promise<void> {
  await runMigrations(config, {
    direction: 'up',
    scope: args.scope as 'core' | 'template',
    templateKey: args['template-key'],
    steps: parseIntOrUndefined(args.steps),
    toVersion: parseIntOrUndefined(args['to-version']),
    dryRun: args['dry-run'],
  });
}

async function handleMigrateDown(config: Config, args: ParsedArgs): Promise<void> {
  await runMigrations(config, {
    direction: 'down',
    scope: args.scope as 'core' | 'template',
    templateKey: args['template-key'],
    steps: args.steps ? Number.parseInt(args.steps, 10) : 1,
    toVersion: parseIntOrUndefined(args['to-version']),
    dryRun: args['dry-run'],
  });
}

async function handleMigrateStatus(config: Config, args: ParsedArgs): Promise<void> {
  await getMigrationStatus(config, {
    scope: args.scope as 'core' | 'template',
    templateKey: args['template-key'],
  });
}

async function handleMigrateVerify(config: Config, args: ParsedArgs): Promise<void> {
  await verifyMigrations(config, {
    scope: args.scope as 'core' | 'template',
    templateKey: args['template-key'],
  });
}

async function handleMigrateCreate(config: Config, args: ParsedArgs): Promise<void> {
  if (!args.name) {
    console.error('Migration name required. Use --name <name>');
    process.exit(1);
  }
  await createMigration(config, {
    name: args.name,
    scope: args.scope as 'core' | 'template',
    templateKey: args['template-key'],
  });
}

async function handleTypesGenerate(config: Config, args: ParsedArgs): Promise<void> {
  await generateTypesFromRegistry(config, {
    appId: args['app-id'],
    outputPath: args.output,
    hooksPath: args.hooks,
    noHooks: args['no-hooks'],
  });
}

async function handleSchemaRegister(config: Config, args: ParsedArgs): Promise<void> {
  if (!args['app-id'] || !args.name || !args.version || !args.file) {
    console.error('Required: --app-id, --name, --version, --file');
    process.exit(1);
  }
  await registerSchema(config, {
    appId: args['app-id'],
    schemaName: args.name,
    version: args.version,
    schemaPath: args.file,
  });
}

async function handleModuleList(config: Config, _args: ParsedArgs): Promise<void> {
  await listModules(config);
}

async function handleModuleRegister(config: Config, args: ParsedArgs): Promise<void> {
  if (!args.name || !args['display-name'] || !args.version || !args['migration-prefix']) {
    console.error('Required: --name, --display-name, --version, --migration-prefix');
    process.exit(1);
  }
  await registerModule(config, {
    name: args.name,
    displayName: args['display-name'],
    version: args.version,
    migrationPrefix: args['migration-prefix'],
    description: args.description,
    dependencies: args.dependencies?.split(',').map((d) => d.trim()),
  });
}

async function handleMigrateModules(config: Config, args: ParsedArgs): Promise<void> {
  await runModuleMigrations(config, {
    modulesPath: args['modules-path'] ?? './migrations/modules',
    dryRun: args['dry-run'],
    steps: parseIntOrUndefined(args.steps),
  });
}

const commandHandlers: Record<string, CommandHandler> = {
  'migrate:up': handleMigrateUp,
  'migrate:down': handleMigrateDown,
  'migrate:status': handleMigrateStatus,
  'migrate:verify': handleMigrateVerify,
  'migrate:create': handleMigrateCreate,
  'migrate:modules': handleMigrateModules,
  'module:list': handleModuleList,
  'module:register': handleModuleRegister,
  'types:generate': handleTypesGenerate,
  'schema:register': handleSchemaRegister,
};

function parseCliArgs(args: string[]): ParsedArgs {
  const { values } = parseArgs({
    args,
    options: {
      'db-url': { type: 'string' },
      migrations: { type: 'string', default: './migrations' },
      scope: { type: 'string', default: 'core' },
      'template-key': { type: 'string' },
      steps: { type: 'string' },
      'to-version': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      name: { type: 'string' },
      'app-id': { type: 'string' },
      output: { type: 'string' },
      hooks: { type: 'string' },
      'no-hooks': { type: 'boolean', default: false },
      version: { type: 'string' },
      file: { type: 'string' },
      'display-name': { type: 'string' },
      'migration-prefix': { type: 'string' },
      description: { type: 'string' },
      dependencies: { type: 'string' },
      'modules-path': { type: 'string' },
    },
    allowPositionals: true,
  });
  return values as ParsedArgs;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printHelp();
    process.exit(0);
  }

  const command = args[0];
  const handler = commandHandlers[command];

  if (!handler) {
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
  }

  const parsedArgs = parseCliArgs(args.slice(1));
  const databaseUrl = parsedArgs['db-url'] ?? process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.error('Database URL required. Set --db-url or DATABASE_URL environment variable.');
    process.exit(1);
  }

  const config: Config = {
    databaseUrl,
    migrationsPath: parsedArgs.migrations,
    typesOutputPath: parsedArgs.output,
  };

  try {
    await handler(config, parsedArgs);
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
