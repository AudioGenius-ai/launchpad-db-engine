import { createHash } from 'node:crypto';
import type { Driver } from '../driver/types.js';
import type { Dialect } from '../migrations/dialects/types.js';
import type { SchemaDefinition } from '../types/index.js';
import type { SchemaRemoteClient } from '../remote/client.js';
import { SchemaDiffEngine } from './diff.js';
import { SchemaIntrospector } from './introspect.js';
import { SyncMetadataManager } from './sync-metadata.js';
import {
  BreakingChangeError,
  UserCancelledError,
  type DiffOptions,
  type PullOptions,
  type PullResult,
  type PushOptions,
  type PushResult,
  type SchemaDiff,
  type SyncStatus,
} from './types.js';

export interface SchemaSyncServiceOptions {
  appId: string;
  migrationsPath?: string;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const defaultLogger: Logger = {
  info: (msg) => console.log(msg),
  warn: (msg) => console.warn(msg),
  error: (msg) => console.error(msg),
};

export class SchemaSyncService {
  private introspector: SchemaIntrospector;
  private diffEngine: SchemaDiffEngine;
  private syncMetadata: SyncMetadataManager;

  constructor(
    private driver: Driver,
    private dialect: Dialect,
    private remoteClient: SchemaRemoteClient,
    private options: SchemaSyncServiceOptions,
    private logger: Logger = defaultLogger
  ) {
    this.introspector = new SchemaIntrospector(driver, dialect);
    this.diffEngine = new SchemaDiffEngine(dialect);
    this.syncMetadata = new SyncMetadataManager(driver, dialect);
  }

  async pull(options: PullOptions = {}): Promise<PullResult> {
    const environment = options.environment ?? 'production';
    this.logger.info(`Fetching schema from ${environment}...`);

    await this.syncMetadata.ensureSyncTable();

    const remote = await this.remoteClient.fetchSchema(environment);

    this.logger.info('Introspecting local database...');
    const localIntrospection = await this.introspector.introspect();
    const localSchema = this.introspector.toSchemaDefinition(localIntrospection);

    const diff = this.diffEngine.computeDiff(localSchema, remote.schema, {
      generateMigration: true,
      migrationName: `sync_pull_${environment}`,
    });

    if (!diff.hasDifferences) {
      this.logger.info('Local schema is up to date');
      return { applied: false, diff };
    }

    this.logger.info(this.diffEngine.formatDiff(diff, 'text'));

    if (options.dryRun) {
      this.logger.info('(dry-run) No changes applied');
      return { applied: false, diff };
    }

    if (diff.breakingChanges.length > 0 && !options.force) {
      throw new BreakingChangeError(
        `Pull would make ${diff.breakingChanges.length} breaking change(s). Use --force to apply anyway.`,
        diff.breakingChanges
      );
    }

    await this.applyMigration(diff);

    const localChecksum = this.computeSchemaChecksum(localSchema);
    await this.syncMetadata.updateSyncState(this.options.appId, 'pull', {
      localChecksum,
      localVersion: diff.migration?.version,
      remoteChecksum: remote.checksum,
      remoteVersion: remote.version,
    });

    this.logger.info('✓ Schema updated successfully');
    return { applied: true, diff };
  }

  async push(options: PushOptions = {}): Promise<PushResult> {
    const environment = options.environment ?? 'production';
    this.logger.info('Introspecting local schema...');

    await this.syncMetadata.ensureSyncTable();

    const localIntrospection = await this.introspector.introspect();
    const localSchema = this.introspector.toSchemaDefinition(localIntrospection);

    this.logger.info(`Fetching remote schema from ${environment}...`);
    const remote = await this.remoteClient.fetchSchema(environment);

    const diff = this.diffEngine.computeDiff(remote.schema, localSchema, {
      generateMigration: true,
      migrationName: `sync_push_${environment}`,
    });

    if (!diff.hasDifferences) {
      this.logger.info('Remote schema is up to date');
      return { applied: false, diff };
    }

    this.logger.info(this.diffEngine.formatDiff(diff, 'text'));

    if (options.dryRun) {
      this.logger.info('(dry-run) No changes would be pushed');
      return { applied: false, diff };
    }

    if (environment === 'production' && !options.force) {
      this.logger.warn('⚠️  You are about to push schema changes to PRODUCTION');
      this.logger.warn('This operation cannot be automatically undone.');
      throw new UserCancelledError(
        'Production push requires --force flag. Review changes carefully before proceeding.'
      );
    }

    if (diff.breakingChanges.length > 0 && !options.force) {
      throw new BreakingChangeError(
        `Push would make ${diff.breakingChanges.length} breaking change(s). Use --force to apply anyway.`,
        diff.breakingChanges
      );
    }

    if (!diff.migration) {
      return { applied: false, diff };
    }

    const remoteResult = await this.remoteClient.pushMigration(diff.migration, {
      environment,
      dryRun: false,
      force: options.force,
    });

    if (remoteResult.success) {
      const localChecksum = this.computeSchemaChecksum(localSchema);
      await this.syncMetadata.updateSyncState(this.options.appId, 'push', {
        localChecksum,
        localVersion: diff.migration.version,
        remoteChecksum: localChecksum,
        remoteVersion: diff.migration.version,
      });

      this.logger.info('✓ Schema pushed successfully');
    } else {
      this.logger.error('✗ Push failed');
      if (remoteResult.errors) {
        for (const error of remoteResult.errors) {
          this.logger.error(`  - ${error}`);
        }
      }
    }

    return { applied: remoteResult.success, diff, remoteResult };
  }

  async diff(options: DiffOptions = {}): Promise<SchemaDiff> {
    const environment = options.environment ?? 'production';

    this.logger.info('Introspecting local schema...');
    const localIntrospection = await this.introspector.introspect();
    const localSchema = this.introspector.toSchemaDefinition(localIntrospection);

    this.logger.info(`Fetching remote schema from ${environment}...`);
    const remote = await this.remoteClient.fetchSchema(environment);

    const diff = this.diffEngine.computeDiff(localSchema, remote.schema, {
      generateMigration: true,
      migrationName: `diff_${environment}`,
    });

    return diff;
  }

  async getSyncStatus(): Promise<SyncStatus | null> {
    await this.syncMetadata.ensureSyncTable();
    return this.syncMetadata.getSyncState(this.options.appId, '__global__');
  }

  async introspectLocal(): Promise<SchemaDefinition> {
    const introspection = await this.introspector.introspect();
    return this.introspector.toSchemaDefinition(introspection);
  }

  formatDiff(diff: SchemaDiff, format: 'text' | 'json' | 'sql' = 'text'): string {
    return this.diffEngine.formatDiff(diff, format);
  }

  private async applyMigration(diff: SchemaDiff): Promise<void> {
    if (!diff.migration) return;

    if (this.dialect.supportsTransactionalDDL) {
      await this.driver.transaction(async (trx) => {
        for (const sql of diff.migration!.upSql) {
          await trx.execute(sql);
        }
      });
    } else {
      for (const sql of diff.migration.upSql) {
        await this.driver.execute(sql);
      }
    }
  }

  private computeSchemaChecksum(schema: SchemaDefinition): string {
    const normalized = JSON.stringify(schema, Object.keys(schema).sort());
    return createHash('sha256').update(normalized).digest('hex');
  }
}

export function createSchemaSyncService(
  driver: Driver,
  dialect: Dialect,
  remoteClient: SchemaRemoteClient,
  options: SchemaSyncServiceOptions,
  logger?: Logger
): SchemaSyncService {
  return new SchemaSyncService(driver, dialect, remoteClient, options, logger);
}
