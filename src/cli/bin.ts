#!/usr/bin/env node

import { parseArgs } from 'node:util';
import {
  createMigration,
  generateTypesFromRegistry,
  getMigrationStatus,
  registerSchema,
  runMigrations,
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
  version?: string;
  file?: string;
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
  types:generate   Generate TypeScript types from registered schemas
  schema:register  Register a schema from a file

Global Options:
  --db-url         Database connection string (or set DATABASE_URL env var)
  --migrations     Path to migrations directory (default: ./migrations)
  --help           Show this help message

Examples:
  launchpad-db migrate:up
  launchpad-db migrate:up --scope template --template-key crm
  launchpad-db migrate:down --steps 1
  launchpad-db migrate:create --name add_users --scope core
  launchpad-db types:generate --output ./src/types.ts
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

const commandHandlers: Record<string, CommandHandler> = {
  'migrate:up': handleMigrateUp,
  'migrate:down': handleMigrateDown,
  'migrate:status': handleMigrateStatus,
  'migrate:verify': handleMigrateVerify,
  'migrate:create': handleMigrateCreate,
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
      version: { type: 'string' },
      file: { type: 'string' },
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
