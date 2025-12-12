import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Driver } from '../driver/types.js';
import type {
  MigrationFile,
  MigrationRecord,
  MigrationResult,
  MigrationStatus,
} from '../types/index.js';
import { getDialect } from './dialects/index.js';
import type { Dialect } from './dialects/types.js';

export interface MigrationRunnerOptions {
  migrationsPath: string;
  tableName?: string;
}

export interface MigrationRunOptions {
  scope?: 'core' | 'template';
  templateKey?: string;
  steps?: number;
  toVersion?: number;
  dryRun?: boolean;
}

export class MigrationRunner {
  private driver: Driver;
  private dialect: Dialect;
  private migrationsPath: string;
  private tableName: string;

  constructor(driver: Driver, options: MigrationRunnerOptions) {
    this.driver = driver;
    this.dialect = getDialect(driver.dialect);
    this.migrationsPath = options.migrationsPath;
    this.tableName = options.tableName ?? 'lp_migrations';
  }

  async ensureMigrationsTable(): Promise<void> {
    const createTableSQL =
      this.dialect.name === 'postgresql'
        ? `
        CREATE TABLE IF NOT EXISTS "${this.tableName}" (
          version BIGINT PRIMARY KEY,
          name TEXT NOT NULL,
          scope TEXT NOT NULL CHECK (scope IN ('core', 'template')),
          template_key TEXT,
          checksum TEXT NOT NULL,
          up_sql TEXT[] NOT NULL,
          down_sql TEXT[],
          applied_at TIMESTAMPTZ DEFAULT NOW(),
          executed_by TEXT
        )
      `
        : this.dialect.name === 'mysql'
          ? `
          CREATE TABLE IF NOT EXISTS \`${this.tableName}\` (
            version BIGINT PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            scope VARCHAR(20) NOT NULL,
            template_key VARCHAR(255),
            checksum VARCHAR(64) NOT NULL,
            up_sql JSON NOT NULL,
            down_sql JSON,
            applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            executed_by VARCHAR(255)
          )
        `
          : `
          CREATE TABLE IF NOT EXISTS "${this.tableName}" (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            scope TEXT NOT NULL CHECK (scope IN ('core', 'template')),
            template_key TEXT,
            checksum TEXT NOT NULL,
            up_sql TEXT NOT NULL,
            down_sql TEXT,
            applied_at TEXT DEFAULT (datetime('now')),
            executed_by TEXT
          )
        `;

    await this.driver.execute(createTableSQL);

    if (this.dialect.name === 'postgresql') {
      await this.driver.execute(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_${this.tableName}_scope_version
        ON "${this.tableName}" (scope, COALESCE(template_key, ''), version)
      `);
    }
  }

  async up(options: MigrationRunOptions = {}): Promise<MigrationResult[]> {
    await this.ensureMigrationsTable();

    const pending = await this.getPendingMigrations(options);
    const results: MigrationResult[] = [];

    let migrationsToRun = pending;
    if (options.steps) {
      migrationsToRun = pending.slice(0, options.steps);
    }
    if (options.toVersion) {
      migrationsToRun = pending.filter((m) => m.version <= options.toVersion!);
    }

    for (const migration of migrationsToRun) {
      const startTime = Date.now();

      if (options.dryRun) {
        console.log(`[DRY RUN] Would apply migration: ${migration.version}__${migration.name}`);
        console.log(migration.up.join('\n'));
        results.push({
          version: migration.version,
          name: migration.name,
          success: true,
          duration: 0,
        });
        continue;
      }

      try {
        if (this.dialect.supportsTransactionalDDL) {
          await this.driver.transaction(async (trx) => {
            for (const sql of migration.up) {
              await trx.execute(sql);
            }
            await this.recordMigration(trx, migration);
          });
        } else {
          for (const sql of migration.up) {
            await this.driver.execute(sql);
          }
          await this.recordMigration(this.driver, migration);
        }

        results.push({
          version: migration.version,
          name: migration.name,
          success: true,
          duration: Date.now() - startTime,
        });
      } catch (error) {
        results.push({
          version: migration.version,
          name: migration.name,
          success: false,
          error: error instanceof Error ? error.message : String(error),
          duration: Date.now() - startTime,
        });
        break;
      }
    }

    return results;
  }

  async down(options: MigrationRunOptions = {}): Promise<MigrationResult[]> {
    await this.ensureMigrationsTable();

    const applied = await this.getAppliedMigrations(options);
    const results: MigrationResult[] = [];

    let migrationsToRollback = applied.reverse();
    if (options.steps) {
      migrationsToRollback = migrationsToRollback.slice(0, options.steps);
    }
    if (options.toVersion) {
      migrationsToRollback = migrationsToRollback.filter((m) => m.version > options.toVersion!);
    }

    for (const migration of migrationsToRollback) {
      if (!migration.downSql?.length) {
        results.push({
          version: migration.version,
          name: migration.name,
          success: false,
          error: 'No down migration available',
          duration: 0,
        });
        break;
      }

      const startTime = Date.now();

      if (options.dryRun) {
        console.log(`[DRY RUN] Would rollback migration: ${migration.version}__${migration.name}`);
        console.log(migration.downSql.join('\n'));
        results.push({
          version: migration.version,
          name: migration.name,
          success: true,
          duration: 0,
        });
        continue;
      }

      try {
        if (this.dialect.supportsTransactionalDDL) {
          await this.driver.transaction(async (trx) => {
            for (const sql of migration.downSql) {
              await trx.execute(sql);
            }
            await this.removeMigrationRecord(trx, migration.version);
          });
        } else {
          for (const sql of migration.downSql) {
            await this.driver.execute(sql);
          }
          await this.removeMigrationRecord(this.driver, migration.version);
        }

        results.push({
          version: migration.version,
          name: migration.name,
          success: true,
          duration: Date.now() - startTime,
        });
      } catch (error) {
        results.push({
          version: migration.version,
          name: migration.name,
          success: false,
          error: error instanceof Error ? error.message : String(error),
          duration: Date.now() - startTime,
        });
        break;
      }
    }

    return results;
  }

  async status(options: MigrationRunOptions = {}): Promise<MigrationStatus> {
    await this.ensureMigrationsTable();

    const applied = await this.getAppliedMigrations(options);
    const pending = await this.getPendingMigrations(options);
    const current = applied.length ? applied[applied.length - 1].version : null;

    return { applied, pending, current };
  }

  async verify(options: MigrationRunOptions = {}): Promise<{ valid: boolean; issues: string[] }> {
    await this.ensureMigrationsTable();

    const applied = await this.getAppliedMigrations(options);
    const files = await this.loadMigrationFiles(options);
    const issues: string[] = [];

    for (const record of applied) {
      const file = files.find((f) => f.version === record.version);
      if (!file) {
        issues.push(`Migration ${record.version}__${record.name} was applied but file is missing`);
        continue;
      }

      const fileChecksum = this.computeChecksum(file.up);
      if (fileChecksum !== record.checksum) {
        issues.push(
          `Migration ${record.version}__${record.name} checksum mismatch. File has been modified after being applied.`
        );
      }
    }

    return { valid: issues.length === 0, issues };
  }

  private async loadMigrationFiles(options: MigrationRunOptions = {}): Promise<MigrationFile[]> {
    const scope = options.scope ?? 'core';
    const dirPath =
      scope === 'template' && options.templateKey
        ? join(this.migrationsPath, 'templates', options.templateKey)
        : join(this.migrationsPath, 'core');

    try {
      const files = await readdir(dirPath);
      const sqlFiles = files.filter((f) => f.endsWith('.sql')).sort();

      const migrations: MigrationFile[] = [];

      for (const file of sqlFiles) {
        const content = await readFile(join(dirPath, file), 'utf-8');
        const parsed = this.parseMigrationFile(file, content, scope, options.templateKey);
        if (parsed) {
          migrations.push(parsed);
        }
      }

      return migrations;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  private parseMigrationFile(
    filename: string,
    content: string,
    scope: 'core' | 'template',
    templateKey?: string
  ): MigrationFile | null {
    const match = filename.match(/^(\d+)__(.+)\.sql$/);
    if (!match) return null;

    const [, versionStr, name] = match;
    const version = Number.parseInt(versionStr, 10);

    const upMatch = content.match(/--\s*up\s*\n([\s\S]*?)(?=--\s*down|$)/i);
    const downMatch = content.match(/--\s*down\s*\n([\s\S]*?)$/i);

    const up = upMatch ? this.splitSqlStatements(upMatch[1]) : [];
    const down = downMatch ? this.splitSqlStatements(downMatch[1]) : [];

    if (!up.length) return null;

    return {
      version,
      name,
      up,
      down,
      scope,
      templateKey,
    };
  }

  private async getAppliedMigrations(
    options: MigrationRunOptions = {}
  ): Promise<MigrationRecord[]> {
    const scope = options.scope ?? 'core';
    const templateKey = options.templateKey ?? null;

    let sql: string;
    let params: unknown[];

    if (this.dialect.name === 'postgresql') {
      sql = `
        SELECT version, name, scope, template_key, checksum, up_sql, down_sql, applied_at, executed_by
        FROM "${this.tableName}"
        WHERE scope = $1 AND (template_key = $2 OR (template_key IS NULL AND $2 IS NULL))
        ORDER BY version ASC
      `;
      params = [scope, templateKey];
    } else {
      sql = `
        SELECT version, name, scope, template_key, checksum, up_sql, down_sql, applied_at, executed_by
        FROM ${this.dialect.name === 'mysql' ? `\`${this.tableName}\`` : `"${this.tableName}"`}
        WHERE scope = ? AND (template_key = ? OR (template_key IS NULL AND ? IS NULL))
        ORDER BY version ASC
      `;
      params = [scope, templateKey, templateKey];
    }

    const result = await this.driver.query<{
      version: number;
      name: string;
      scope: 'core' | 'template';
      template_key: string | null;
      checksum: string;
      up_sql: string[] | string;
      down_sql: string[] | string | null;
      applied_at: Date | string;
      executed_by: string | null;
    }>(sql, params);

    return result.rows.map((row) => ({
      version: Number(row.version),
      name: row.name,
      scope: row.scope,
      templateKey: row.template_key,
      checksum: row.checksum,
      upSql: typeof row.up_sql === 'string' ? JSON.parse(row.up_sql) : row.up_sql,
      downSql: row.down_sql
        ? typeof row.down_sql === 'string'
          ? JSON.parse(row.down_sql)
          : row.down_sql
        : [],
      appliedAt: new Date(row.applied_at),
      executedBy: row.executed_by,
    }));
  }

  private async getPendingMigrations(options: MigrationRunOptions = {}): Promise<MigrationFile[]> {
    const files = await this.loadMigrationFiles(options);
    const applied = await this.getAppliedMigrations(options);
    const appliedVersions = new Set(applied.map((m) => m.version));

    return files.filter((f) => !appliedVersions.has(f.version));
  }

  private async recordMigration(
    client:
      | Driver
      | { execute: (sql: string, params?: unknown[]) => Promise<{ rowCount: number }> },
    migration: MigrationFile
  ): Promise<void> {
    const checksum = this.computeChecksum(migration.up);

    if (this.dialect.name === 'postgresql') {
      await client.execute(
        `
        INSERT INTO "${this.tableName}" (version, name, scope, template_key, checksum, up_sql, down_sql)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        [
          migration.version,
          migration.name,
          migration.scope,
          migration.templateKey ?? null,
          checksum,
          migration.up,
          migration.down.length ? migration.down : null,
        ]
      );
    } else if (this.dialect.name === 'mysql') {
      await client.execute(
        `
        INSERT INTO \`${this.tableName}\` (version, name, scope, template_key, checksum, up_sql, down_sql)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [
          migration.version,
          migration.name,
          migration.scope,
          migration.templateKey ?? null,
          checksum,
          JSON.stringify(migration.up),
          migration.down.length ? JSON.stringify(migration.down) : null,
        ]
      );
    } else {
      await client.execute(
        `
        INSERT INTO "${this.tableName}" (version, name, scope, template_key, checksum, up_sql, down_sql)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [
          migration.version,
          migration.name,
          migration.scope,
          migration.templateKey ?? null,
          checksum,
          JSON.stringify(migration.up),
          migration.down.length ? JSON.stringify(migration.down) : null,
        ]
      );
    }
  }

  private async removeMigrationRecord(
    client:
      | Driver
      | { execute: (sql: string, params?: unknown[]) => Promise<{ rowCount: number }> },
    version: number
  ): Promise<void> {
    if (this.dialect.name === 'postgresql') {
      await client.execute(`DELETE FROM "${this.tableName}" WHERE version = $1`, [version]);
    } else {
      await client.execute(
        `DELETE FROM ${this.dialect.name === 'mysql' ? `\`${this.tableName}\`` : `"${this.tableName}"`} WHERE version = ?`,
        [version]
      );
    }
  }

  private computeChecksum(statements: string[]): string {
    return createHash('sha256').update(statements.join('\n')).digest('hex');
  }

  private splitSqlStatements(sql: string): string[] {
    const statements: string[] = [];
    let current = '';
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inDollarQuote = false;
    let dollarTag = '';
    let inLineComment = false;
    let inBlockComment = false;

    for (let i = 0; i < sql.length; i++) {
      const char = sql[i];
      const next = sql[i + 1] || '';

      if (inLineComment) {
        current += char;
        if (char === '\n') {
          inLineComment = false;
        }
        continue;
      }

      if (inBlockComment) {
        current += char;
        if (char === '*' && next === '/') {
          current += next;
          i++;
          inBlockComment = false;
        }
        continue;
      }

      if (inDollarQuote) {
        current += char;
        if (char === '$') {
          const endTag = sql.slice(i).match(/^\$[a-zA-Z0-9_]*\$/);
          if (endTag && endTag[0] === dollarTag) {
            current += sql.slice(i + 1, i + dollarTag.length);
            i += dollarTag.length - 1;
            inDollarQuote = false;
            dollarTag = '';
          }
        }
        continue;
      }

      if (inSingleQuote) {
        current += char;
        if (char === "'" && next !== "'") {
          inSingleQuote = false;
        } else if (char === "'" && next === "'") {
          current += next;
          i++;
        }
        continue;
      }

      if (inDoubleQuote) {
        current += char;
        if (char === '"' && next !== '"') {
          inDoubleQuote = false;
        } else if (char === '"' && next === '"') {
          current += next;
          i++;
        }
        continue;
      }

      if (char === '-' && next === '-') {
        inLineComment = true;
        current += char;
        continue;
      }

      if (char === '/' && next === '*') {
        inBlockComment = true;
        current += char;
        continue;
      }

      if (char === '$') {
        const tag = sql.slice(i).match(/^\$[a-zA-Z0-9_]*\$/);
        if (tag) {
          inDollarQuote = true;
          dollarTag = tag[0];
          current += dollarTag;
          i += dollarTag.length - 1;
          continue;
        }
      }

      if (char === "'") {
        inSingleQuote = true;
        current += char;
        continue;
      }

      if (char === '"') {
        inDoubleQuote = true;
        current += char;
        continue;
      }

      if (char === ';') {
        const trimmed = current.trim();
        if (trimmed) {
          statements.push(trimmed);
        }
        current = '';
        continue;
      }

      current += char;
    }

    const trimmed = current.trim();
    if (trimmed) {
      statements.push(trimmed);
    }

    return statements;
  }
}

export function createMigrationRunner(
  driver: Driver,
  options: MigrationRunnerOptions
): MigrationRunner {
  return new MigrationRunner(driver, options);
}
