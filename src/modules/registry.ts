import type { Driver } from '../driver/types.js';
import { getDialect } from '../migrations/dialects/index.js';
import type { Dialect } from '../migrations/dialects/types.js';
import type { ModuleDefinition } from './types.js';

export interface ModuleRegistryOptions {
  tableName?: string;
}

export class ModuleRegistry {
  private driver: Driver;
  private dialect: Dialect;
  private tableName: string;

  constructor(driver: Driver, options: ModuleRegistryOptions = {}) {
    this.driver = driver;
    this.dialect = getDialect(driver.dialect);
    this.tableName = options.tableName ?? 'lp_module_registry';
  }

  async ensureTable(): Promise<void> {
    const createTableSQL =
      this.dialect.name === 'postgresql'
        ? `
        CREATE TABLE IF NOT EXISTS "${this.tableName}" (
          name TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          description TEXT,
          version TEXT NOT NULL,
          dependencies TEXT[] DEFAULT '{}',
          migration_prefix TEXT NOT NULL UNIQUE,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `
        : this.dialect.name === 'mysql'
          ? `
          CREATE TABLE IF NOT EXISTS \`${this.tableName}\` (
            name VARCHAR(255) PRIMARY KEY,
            display_name VARCHAR(255) NOT NULL,
            description TEXT,
            version VARCHAR(50) NOT NULL,
            dependencies JSON DEFAULT ('[]'),
            migration_prefix VARCHAR(255) NOT NULL UNIQUE,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
          )
        `
          : `
          CREATE TABLE IF NOT EXISTS "${this.tableName}" (
            name TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            description TEXT,
            version TEXT NOT NULL,
            dependencies TEXT DEFAULT '[]',
            migration_prefix TEXT NOT NULL UNIQUE,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
          )
        `;

    await this.driver.execute(createTableSQL);
  }

  async register(module: ModuleDefinition): Promise<void> {
    await this.ensureTable();

    const dependencies = module.dependencies ?? [];

    if (this.dialect.name === 'postgresql') {
      await this.driver.execute(
        `
        INSERT INTO "${this.tableName}" (name, display_name, description, version, dependencies, migration_prefix)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (name) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          description = EXCLUDED.description,
          version = EXCLUDED.version,
          dependencies = EXCLUDED.dependencies,
          migration_prefix = EXCLUDED.migration_prefix,
          updated_at = NOW()
        `,
        [
          module.name,
          module.displayName,
          module.description ?? null,
          module.version,
          dependencies,
          module.migrationPrefix,
        ]
      );
    } else if (this.dialect.name === 'mysql') {
      await this.driver.execute(
        `
        INSERT INTO \`${this.tableName}\` (name, display_name, description, version, dependencies, migration_prefix)
        VALUES (?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          display_name = VALUES(display_name),
          description = VALUES(description),
          version = VALUES(version),
          dependencies = VALUES(dependencies),
          migration_prefix = VALUES(migration_prefix)
        `,
        [
          module.name,
          module.displayName,
          module.description ?? null,
          module.version,
          JSON.stringify(dependencies),
          module.migrationPrefix,
        ]
      );
    } else {
      await this.driver.execute(
        `
        INSERT INTO "${this.tableName}" (name, display_name, description, version, dependencies, migration_prefix)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (name) DO UPDATE SET
          display_name = excluded.display_name,
          description = excluded.description,
          version = excluded.version,
          dependencies = excluded.dependencies,
          migration_prefix = excluded.migration_prefix,
          updated_at = datetime('now')
        `,
        [
          module.name,
          module.displayName,
          module.description ?? null,
          module.version,
          JSON.stringify(dependencies),
          module.migrationPrefix,
        ]
      );
    }
  }

  async get(name: string): Promise<ModuleDefinition | null> {
    await this.ensureTable();

    let sql: string;
    let params: unknown[];

    if (this.dialect.name === 'postgresql') {
      sql = `
        SELECT name, display_name, description, version, dependencies, migration_prefix
        FROM "${this.tableName}"
        WHERE name = $1
      `;
      params = [name];
    } else {
      sql = `
        SELECT name, display_name, description, version, dependencies, migration_prefix
        FROM ${this.dialect.name === 'mysql' ? `\`${this.tableName}\`` : `"${this.tableName}"`}
        WHERE name = ?
      `;
      params = [name];
    }

    const result = await this.driver.query<{
      name: string;
      display_name: string;
      description: string | null;
      version: string;
      dependencies: string[] | string;
      migration_prefix: string;
    }>(sql, params);

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      name: row.name,
      displayName: row.display_name,
      description: row.description ?? undefined,
      version: row.version,
      dependencies:
        typeof row.dependencies === 'string'
          ? JSON.parse(row.dependencies)
          : row.dependencies,
      migrationPrefix: row.migration_prefix,
    };
  }

  async list(): Promise<ModuleDefinition[]> {
    await this.ensureTable();

    const sql =
      this.dialect.name === 'postgresql'
        ? `
        SELECT name, display_name, description, version, dependencies, migration_prefix
        FROM "${this.tableName}"
        ORDER BY name ASC
      `
        : `
        SELECT name, display_name, description, version, dependencies, migration_prefix
        FROM ${this.dialect.name === 'mysql' ? `\`${this.tableName}\`` : `"${this.tableName}"`}
        ORDER BY name ASC
      `;

    const result = await this.driver.query<{
      name: string;
      display_name: string;
      description: string | null;
      version: string;
      dependencies: string[] | string;
      migration_prefix: string;
    }>(sql);

    return result.rows.map((row) => ({
      name: row.name,
      displayName: row.display_name,
      description: row.description ?? undefined,
      version: row.version,
      dependencies:
        typeof row.dependencies === 'string'
          ? JSON.parse(row.dependencies)
          : row.dependencies,
      migrationPrefix: row.migration_prefix,
    }));
  }

  async unregister(name: string): Promise<void> {
    await this.ensureTable();

    if (this.dialect.name === 'postgresql') {
      await this.driver.execute(`DELETE FROM "${this.tableName}" WHERE name = $1`, [name]);
    } else {
      await this.driver.execute(
        `DELETE FROM ${this.dialect.name === 'mysql' ? `\`${this.tableName}\`` : `"${this.tableName}"`} WHERE name = ?`,
        [name]
      );
    }
  }
}

export function createModuleRegistry(
  driver: Driver,
  options: ModuleRegistryOptions = {}
): ModuleRegistry {
  return new ModuleRegistry(driver, options);
}
