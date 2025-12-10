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

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printHelp();
    process.exit(0);
  }

  const command = args[0];
  const validCommands = [
    'migrate:up',
    'migrate:down',
    'migrate:status',
    'migrate:verify',
    'migrate:create',
    'types:generate',
    'schema:register',
  ];

  if (!validCommands.includes(command)) {
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
  }

  const { values } = parseArgs({
    args: args.slice(1),
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

  const v = values as ParsedArgs;

  const databaseUrl = v['db-url'] ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('Database URL required. Set --db-url or DATABASE_URL environment variable.');
    process.exit(1);
  }

  const config = {
    databaseUrl,
    migrationsPath: v.migrations,
    typesOutputPath: v.output,
  };

  try {
    switch (command) {
      case 'migrate:up':
        await runMigrations(config, {
          direction: 'up',
          scope: v.scope as 'core' | 'template',
          templateKey: v['template-key'],
          steps: v.steps ? Number.parseInt(v.steps, 10) : undefined,
          toVersion: v['to-version'] ? Number.parseInt(v['to-version'], 10) : undefined,
          dryRun: v['dry-run'],
        });
        break;

      case 'migrate:down':
        await runMigrations(config, {
          direction: 'down',
          scope: v.scope as 'core' | 'template',
          templateKey: v['template-key'],
          steps: v.steps ? Number.parseInt(v.steps, 10) : 1,
          toVersion: v['to-version'] ? Number.parseInt(v['to-version'], 10) : undefined,
          dryRun: v['dry-run'],
        });
        break;

      case 'migrate:status':
        await getMigrationStatus(config, {
          scope: v.scope as 'core' | 'template',
          templateKey: v['template-key'],
        });
        break;

      case 'migrate:verify':
        await verifyMigrations(config, {
          scope: v.scope as 'core' | 'template',
          templateKey: v['template-key'],
        });
        break;

      case 'migrate:create':
        if (!v.name) {
          console.error('Migration name required. Use --name <name>');
          process.exit(1);
        }
        await createMigration(config, {
          name: v.name,
          scope: v.scope as 'core' | 'template',
          templateKey: v['template-key'],
        });
        break;

      case 'types:generate':
        await generateTypesFromRegistry(config, {
          appId: v['app-id'],
          outputPath: v.output,
        });
        break;

      case 'schema:register':
        if (!v['app-id'] || !v.name || !v.version || !v.file) {
          console.error('Required: --app-id, --name, --version, --file');
          process.exit(1);
        }
        await registerSchema(config, {
          appId: v['app-id'],
          schemaName: v.name,
          version: v.version,
          schemaPath: v.file,
        });
        break;
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
