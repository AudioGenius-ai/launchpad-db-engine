import { createHash } from 'crypto';
import type { Driver } from '../driver/types.js';
import type { SchemaDefinition, TableDefinition, MigrationResult } from '../types/index.js';
import { getDialect, type Dialect } from '../migrations/dialects/index.js';

export interface SchemaRegistryOptions {
  tableName?: string;
}

export interface RegisterSchemaOptions {
  appId: string;
  schemaName: string;
  version: string;
  schema: SchemaDefinition;
}

export interface SchemaRecord {
  app_id: string;
  schema_name: string;
  version: string;
  schema: SchemaDefinition;
  checksum: string;
  created_at: Date;
  updated_at: Date;
}

export class SchemaRegistry {
  private driver: Driver;
  private dialect: Dialect;
  private tableName: string;

  constructor(driver: Driver, options: SchemaRegistryOptions = {}) {
    this.driver = driver;
    this.dialect = getDialect(driver.dialect);
    this.tableName = options.tableName ?? 'lp_schema_registry';
  }

  async ensureRegistryTable(): Promise<void> {
    const createTableSQL = this.dialect.name === 'postgresql'
      ? `
        CREATE TABLE IF NOT EXISTS "${this.tableName}" (
          app_id TEXT NOT NULL,
          schema_name TEXT NOT NULL,
          version TEXT NOT NULL,
          schema JSONB NOT NULL,
          checksum TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (app_id, schema_name)
        )
      `
      : this.dialect.name === 'mysql'
        ? `
          CREATE TABLE IF NOT EXISTS \`${this.tableName}\` (
            app_id VARCHAR(255) NOT NULL,
            schema_name VARCHAR(255) NOT NULL,
            version VARCHAR(50) NOT NULL,
            schema JSON NOT NULL,
            checksum VARCHAR(64) NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (app_id, schema_name)
          )
        `
        : `
          CREATE TABLE IF NOT EXISTS "${this.tableName}" (
            app_id TEXT NOT NULL,
            schema_name TEXT NOT NULL,
            version TEXT NOT NULL,
            schema TEXT NOT NULL,
            checksum TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            PRIMARY KEY (app_id, schema_name)
          )
        `;

    await this.driver.execute(createTableSQL);
  }

  async register(options: RegisterSchemaOptions): Promise<MigrationResult[]> {
    await this.ensureRegistryTable();

    this.validateSchema(options.schema);

    const current = await this.getCurrentSchema(options.appId, options.schemaName);
    const diff = this.computeDiff(current?.schema ?? null, options.schema);

    if (diff.length === 0) {
      return [];
    }

    const results: MigrationResult[] = [];
    const checksum = this.computeChecksum(options.schema);

    if (this.dialect.supportsTransactionalDDL) {
      await this.driver.transaction(async (trx) => {
        for (const change of diff) {
          const startTime = Date.now();
          try {
            await trx.execute(change.sql);
            results.push({
              version: Date.now(),
              name: change.description,
              success: true,
              duration: Date.now() - startTime,
            });
          } catch (error) {
            results.push({
              version: Date.now(),
              name: change.description,
              success: false,
              error: error instanceof Error ? error.message : String(error),
              duration: Date.now() - startTime,
            });
            throw error;
          }
        }

        await this.upsertSchemaRecord(trx, {
          appId: options.appId,
          schemaName: options.schemaName,
          version: options.version,
          schema: options.schema,
          checksum,
        });
      });
    } else {
      for (const change of diff) {
        const startTime = Date.now();
        try {
          await this.driver.execute(change.sql);
          results.push({
            version: Date.now(),
            name: change.description,
            success: true,
            duration: Date.now() - startTime,
          });
        } catch (error) {
          results.push({
            version: Date.now(),
            name: change.description,
            success: false,
            error: error instanceof Error ? error.message : String(error),
            duration: Date.now() - startTime,
          });
          throw error;
        }
      }

      await this.upsertSchemaRecord(this.driver, {
        appId: options.appId,
        schemaName: options.schemaName,
        version: options.version,
        schema: options.schema,
        checksum,
      });
    }

    return results;
  }

  async getCurrentSchema(appId: string, schemaName: string): Promise<SchemaRecord | null> {
    let sql: string;
    let params: unknown[];

    if (this.dialect.name === 'postgresql') {
      sql = `
        SELECT app_id, schema_name, version, schema, checksum, created_at, updated_at
        FROM "${this.tableName}"
        WHERE app_id = $1 AND schema_name = $2
      `;
      params = [appId, schemaName];
    } else {
      sql = `
        SELECT app_id, schema_name, version, schema, checksum, created_at, updated_at
        FROM ${this.dialect.name === 'mysql' ? `\`${this.tableName}\`` : `"${this.tableName}"`}
        WHERE app_id = ? AND schema_name = ?
      `;
      params = [appId, schemaName];
    }

    const result = await this.driver.query<{
      app_id: string;
      schema_name: string;
      version: string;
      schema: SchemaDefinition | string;
      checksum: string;
      created_at: Date | string;
      updated_at: Date | string;
    }>(sql, params);

    if (!result.rows.length) return null;

    const row = result.rows[0];
    return {
      app_id: row.app_id,
      schema_name: row.schema_name,
      version: row.version,
      schema: typeof row.schema === 'string' ? JSON.parse(row.schema) : row.schema,
      checksum: row.checksum,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
    };
  }

  async listSchemas(appId?: string): Promise<SchemaRecord[]> {
    let sql: string;
    let params: unknown[];

    if (this.dialect.name === 'postgresql') {
      sql = appId
        ? `SELECT * FROM "${this.tableName}" WHERE app_id = $1 ORDER BY schema_name`
        : `SELECT * FROM "${this.tableName}" ORDER BY app_id, schema_name`;
      params = appId ? [appId] : [];
    } else {
      const table = this.dialect.name === 'mysql' ? `\`${this.tableName}\`` : `"${this.tableName}"`;
      sql = appId
        ? `SELECT * FROM ${table} WHERE app_id = ? ORDER BY schema_name`
        : `SELECT * FROM ${table} ORDER BY app_id, schema_name`;
      params = appId ? [appId] : [];
    }

    const result = await this.driver.query<{
      app_id: string;
      schema_name: string;
      version: string;
      schema: SchemaDefinition | string;
      checksum: string;
      created_at: Date | string;
      updated_at: Date | string;
    }>(sql, params);

    return result.rows.map(row => ({
      app_id: row.app_id,
      schema_name: row.schema_name,
      version: row.version,
      schema: typeof row.schema === 'string' ? JSON.parse(row.schema) : row.schema,
      checksum: row.checksum,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
    }));
  }

  private validateSchema(schema: SchemaDefinition): void {
    for (const [tableName, table] of Object.entries(schema.tables)) {
      if (!table.columns.app_id) {
        throw new Error(`Table "${tableName}" must have an "app_id" column for multi-tenancy`);
      }
      if (!table.columns.organization_id) {
        throw new Error(`Table "${tableName}" must have an "organization_id" column for multi-tenancy`);
      }
      if (!table.columns.id) {
        throw new Error(`Table "${tableName}" must have an "id" column`);
      }

      const appIdCol = table.columns.app_id;
      const orgIdCol = table.columns.organization_id;

      if (!appIdCol.tenant) {
        throw new Error(`Column "app_id" in table "${tableName}" must be marked as tenant column`);
      }
      if (!orgIdCol.tenant) {
        throw new Error(`Column "organization_id" in table "${tableName}" must be marked as tenant column`);
      }
    }
  }

  private computeDiff(
    current: SchemaDefinition | null,
    desired: SchemaDefinition
  ): Array<{ sql: string; description: string }> {
    const changes: Array<{ sql: string; description: string }> = [];

    for (const [tableName, desiredTable] of Object.entries(desired.tables)) {
      const currentTable = current?.tables[tableName];

      if (!currentTable) {
        const sql = this.dialect.createTable(tableName, desiredTable);
        changes.push({ sql, description: `Create table ${tableName}` });

        if (desiredTable.indexes) {
          for (const index of desiredTable.indexes) {
            const indexSql = this.dialect.createIndex(tableName, index);
            changes.push({
              sql: indexSql,
              description: `Create index on ${tableName}(${index.columns.join(', ')})`,
            });
          }
        }

        continue;
      }

      for (const [colName, desiredCol] of Object.entries(desiredTable.columns)) {
        const currentCol = currentTable.columns[colName];

        if (!currentCol) {
          const sql = this.dialect.addColumn(tableName, colName, desiredCol);
          changes.push({ sql, description: `Add column ${tableName}.${colName}` });
        } else if (!this.columnsEqual(currentCol, desiredCol)) {
          try {
            const sql = this.dialect.alterColumn(tableName, colName, desiredCol);
            changes.push({ sql, description: `Alter column ${tableName}.${colName}` });
          } catch (error) {
            console.warn(`Cannot alter column ${tableName}.${colName}: ${error}`);
          }
        }
      }

      for (const colName of Object.keys(currentTable.columns)) {
        if (!desiredTable.columns[colName]) {
          const sql = this.dialect.dropColumn(tableName, colName);
          changes.push({ sql, description: `Drop column ${tableName}.${colName}` });
        }
      }
    }

    if (current) {
      for (const tableName of Object.keys(current.tables)) {
        if (!desired.tables[tableName]) {
          const sql = this.dialect.dropTable(tableName);
          changes.push({ sql, description: `Drop table ${tableName}` });
        }
      }
    }

    return changes;
  }

  private columnsEqual(a: TableDefinition['columns'][string], b: TableDefinition['columns'][string]): boolean {
    return (
      a.type === b.type &&
      a.nullable === b.nullable &&
      a.unique === b.unique &&
      a.default === b.default &&
      JSON.stringify(a.references) === JSON.stringify(b.references)
    );
  }

  private async upsertSchemaRecord(
    client: Driver | { execute: (sql: string, params?: unknown[]) => Promise<{ rowCount: number }> },
    data: {
      appId: string;
      schemaName: string;
      version: string;
      schema: SchemaDefinition;
      checksum: string;
    }
  ): Promise<void> {
    const schemaJson = JSON.stringify(data.schema);

    if (this.dialect.name === 'postgresql') {
      await client.execute(
        `
        INSERT INTO "${this.tableName}" (app_id, schema_name, version, schema, checksum)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (app_id, schema_name) DO UPDATE SET
          version = EXCLUDED.version,
          schema = EXCLUDED.schema,
          checksum = EXCLUDED.checksum,
          updated_at = NOW()
        `,
        [data.appId, data.schemaName, data.version, schemaJson, data.checksum]
      );
    } else if (this.dialect.name === 'mysql') {
      await client.execute(
        `
        INSERT INTO \`${this.tableName}\` (app_id, schema_name, version, schema, checksum)
        VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          version = VALUES(version),
          schema = VALUES(schema),
          checksum = VALUES(checksum)
        `,
        [data.appId, data.schemaName, data.version, schemaJson, data.checksum]
      );
    } else {
      await client.execute(
        `
        INSERT OR REPLACE INTO "${this.tableName}" (app_id, schema_name, version, schema, checksum, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        `,
        [data.appId, data.schemaName, data.version, schemaJson, data.checksum]
      );
    }
  }

  private computeChecksum(schema: SchemaDefinition): string {
    return createHash('sha256').update(JSON.stringify(schema)).digest('hex');
  }
}

export function createSchemaRegistry(driver: Driver, options?: SchemaRegistryOptions): SchemaRegistry {
  return new SchemaRegistry(driver, options);
}
