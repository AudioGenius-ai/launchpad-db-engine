import type { Driver } from '../driver/types.js';
import { SchemaDiffer } from './schema-differ.js';
import type { Conflict, ConflictResolution, MergeOptions, MergeResult } from './types.js';

export interface MigrationRecord {
  version: number;
  name: string;
  scope: 'core' | 'template';
  checksum: string;
  upSql: string[];
  downSql: string[];
  appliedAt: Date;
}

export interface MigrationMergerOptions {
  mainSchema?: string;
  branchPrefix?: string;
  migrationsTable?: string;
}

export class MigrationMerger {
  private driver: Driver;
  private mainSchema: string;
  private migrationsTable: string;

  constructor(driver: Driver, options: MigrationMergerOptions = {}) {
    this.driver = driver;
    this.mainSchema = options.mainSchema ?? 'public';
    this.migrationsTable = options.migrationsTable ?? 'lp_migrations';
  }

  async merge(options: MergeOptions): Promise<MergeResult> {
    const { sourceBranch, targetBranch, dryRun, conflictResolution } = options;

    const sourceSchema = await this.resolveSchemaName(sourceBranch);
    const targetSchema = await this.resolveSchemaName(targetBranch);

    const differ = new SchemaDiffer(this.driver);
    const diff = await differ.diff(sourceSchema, targetSchema);

    if (!diff.hasChanges) {
      return {
        success: true,
        migrationsApplied: 0,
        conflicts: [],
        errors: [],
        rollbackAvailable: false,
      };
    }

    if (
      diff.conflicts.length > 0 &&
      !this.allConflictsResolved(diff.conflicts, conflictResolution)
    ) {
      return {
        success: false,
        migrationsApplied: 0,
        conflicts: diff.conflicts,
        errors: ['Unresolved conflicts detected. Provide conflict resolutions.'],
        rollbackAvailable: false,
      };
    }

    if (dryRun) {
      return {
        success: true,
        migrationsApplied: diff.forwardSql.length,
        conflicts: [],
        errors: [],
        rollbackAvailable: false,
      };
    }

    try {
      await this.driver.transaction(async (trx) => {
        for (const sql of diff.forwardSql) {
          const adjustedSql = sql.replace(
            new RegExp(`"${sourceSchema}"`, 'g'),
            `"${targetSchema}"`
          );
          await trx.execute(adjustedSql);
        }

        await trx.execute(
          `
          INSERT INTO ${this.quoteIdent(this.migrationsTable)} (
            version, name, scope, checksum, up_sql, down_sql
          ) VALUES (
            EXTRACT(EPOCH FROM NOW())::BIGINT * 1000 + (random() * 1000)::INT,
            $1,
            'core',
            $2,
            $3,
            $4
          )
        `,
          [
            `merge_${sourceBranch}_to_${targetBranch}`,
            this.computeChecksum(diff.forwardSql),
            diff.forwardSql,
            diff.reverseSql,
          ]
        );
      });

      return {
        success: true,
        migrationsApplied: diff.forwardSql.length,
        conflicts: [],
        errors: [],
        rollbackAvailable: true,
      };
    } catch (error) {
      return {
        success: false,
        migrationsApplied: 0,
        conflicts: [],
        errors: [error instanceof Error ? error.message : String(error)],
        rollbackAvailable: false,
      };
    }
  }

  async getPendingMigrations(
    _sourceBranch: string,
    _targetBranch: string
  ): Promise<MigrationRecord[]> {
    const result = await this.driver.query<{
      version: string | number;
      name: string;
      scope: 'core' | 'template';
      checksum: string;
      up_sql: string[] | string;
      down_sql: string[] | string | null;
      applied_at: Date | string;
    }>(`
      SELECT s.version, s.name, s.scope, s.checksum, s.up_sql, s.down_sql, s.applied_at
      FROM ${this.quoteIdent(this.migrationsTable)} s
      WHERE NOT EXISTS (
        SELECT 1 FROM ${this.quoteIdent(this.migrationsTable)} t
        WHERE t.version = s.version
      )
      ORDER BY s.version ASC
    `);

    return result.rows.map((row) => ({
      version: typeof row.version === 'string' ? Number.parseInt(row.version, 10) : row.version,
      name: row.name,
      scope: row.scope,
      checksum: row.checksum,
      upSql: typeof row.up_sql === 'string' ? JSON.parse(row.up_sql) : row.up_sql,
      downSql: row.down_sql
        ? typeof row.down_sql === 'string'
          ? JSON.parse(row.down_sql)
          : row.down_sql
        : [],
      appliedAt: new Date(row.applied_at),
    }));
  }

  async detectMigrationConflicts(
    migrations: MigrationRecord[],
    targetBranch: string
  ): Promise<Conflict[]> {
    const conflicts: Conflict[] = [];
    const targetSchema = await this.resolveSchemaName(targetBranch);

    const tableNames = new Set<string>();
    for (const migration of migrations) {
      for (const sql of migration.upSql) {
        const createMatch = sql.match(/CREATE TABLE\s+(?:"[^"]+"\.)?"([^"]+)"/i);
        const alterMatch = sql.match(/ALTER TABLE\s+(?:"[^"]+"\.)?"([^"]+)"/i);

        const tableName = createMatch?.[1] || alterMatch?.[1];
        if (tableName) {
          tableNames.add(tableName);
        }
      }
    }

    for (const tableName of tableNames) {
      const exists = await this.tableExists(targetSchema, tableName);

      if (exists) {
        const willBeCreated = migrations.some((m) =>
          m.upSql.some((sql) =>
            sql.match(new RegExp(`CREATE TABLE\\s+(?:"[^"]+"\\.)?["']?${tableName}["']?`, 'i'))
          )
        );

        if (willBeCreated) {
          conflicts.push({
            type: 'table_removed',
            description: `Table ${tableName} already exists in target branch but will be created by migration`,
            sourcePath: tableName,
            targetPath: tableName,
            resolution: ['keep_source', 'keep_target', 'manual'],
          });
        }
      }
    }

    return conflicts;
  }

  private allConflictsResolved(
    conflicts: Conflict[],
    resolution?: Record<string, ConflictResolution>
  ): boolean {
    if (!resolution) {
      return conflicts.length === 0;
    }

    for (const conflict of conflicts) {
      const key = conflict.sourcePath;
      if (!resolution[key]) {
        return false;
      }
    }

    return true;
  }

  private async resolveSchemaName(branchName: string): Promise<string> {
    if (branchName === 'main' || branchName === 'public') {
      return this.mainSchema;
    }

    const result = await this.driver.query<{ schema_name: string }>(
      `
      SELECT schema_name FROM lp_branch_metadata
      WHERE slug = $1 AND deleted_at IS NULL
    `,
      [branchName]
    );

    if (result.rows.length === 0) {
      throw new Error(`Branch '${branchName}' not found`);
    }

    return result.rows[0].schema_name;
  }

  private async tableExists(schema: string, tableName: string): Promise<boolean> {
    const result = await this.driver.query<{ exists: boolean }>(
      `
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = $1 AND table_name = $2
      ) as exists
    `,
      [schema, tableName]
    );

    return result.rows[0]?.exists ?? false;
  }

  private computeChecksum(statements: string[]): string {
    const { createHash } = require('node:crypto');
    return createHash('sha256').update(statements.join('\n')).digest('hex');
  }

  private quoteIdent(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
  }
}
