import type { Driver } from '../driver/types.js';
import type { Dialect } from '../migrations/dialects/types.js';
import type { ColumnDefinition, ColumnType, SchemaDefinition, TableDefinition } from '../types/index.js';
import type {
  IntrospectedColumn,
  IntrospectedConstraint,
  IntrospectedEnum,
  IntrospectedForeignKey,
  IntrospectedIndex,
  IntrospectedTable,
  IntrospectOptions,
  SchemaIntrospectionResult,
} from './types.js';

export class SchemaIntrospector {
  constructor(
    private driver: Driver,
    private dialect: Dialect
  ) {}

  async introspect(options: IntrospectOptions = {}): Promise<SchemaIntrospectionResult> {
    const tables = await this.introspectTables(options);
    const enums = await this.introspectEnums();
    const extensions = await this.introspectExtensions();
    const databaseVersion = await this.getDatabaseVersion();

    return {
      tables,
      enums,
      extensions,
      introspectedAt: new Date(),
      databaseVersion,
    };
  }

  async introspectTables(options: IntrospectOptions = {}): Promise<IntrospectedTable[]> {
    const tableNames = await this.listTables(options);
    const tables: IntrospectedTable[] = [];

    for (const tableName of tableNames) {
      const table = await this.introspectTable(tableName);
      tables.push(table);
    }

    return tables;
  }

  async listTables(options: IntrospectOptions = {}): Promise<string[]> {
    const excludePatterns = options.includeLaunchpadTables
      ? []
      : ['lp_%', 'pg_%', 'sql_%'];
    const additionalExcludes = options.excludeTables ?? [];

    let sql: string;

    if (this.dialect.name === 'postgresql') {
      sql = `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `;
    } else if (this.dialect.name === 'mysql') {
      sql = `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = DATABASE()
          AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `;
    } else {
      sql = `
        SELECT name as table_name
        FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `;
    }

    const result = await this.driver.query<{ table_name: string }>(sql);

    return result.rows
      .map((row) => row.table_name)
      .filter((name) => {
        for (const pattern of excludePatterns) {
          if (pattern.endsWith('%')) {
            const prefix = pattern.slice(0, -1);
            if (name.startsWith(prefix)) return false;
          } else if (name === pattern) {
            return false;
          }
        }
        for (const exclude of additionalExcludes) {
          if (name === exclude) return false;
        }
        return true;
      });
  }

  async introspectTable(tableName: string): Promise<IntrospectedTable> {
    const [columns, indexes, foreignKeys, constraints] = await Promise.all([
      this.introspectColumns(tableName),
      this.introspectIndexes(tableName),
      this.introspectForeignKeys(tableName),
      this.introspectConstraints(tableName),
    ]);

    const primaryKey = this.extractPrimaryKey(indexes);

    return {
      name: tableName,
      schema: 'public',
      columns,
      primaryKey,
      foreignKeys,
      indexes: indexes.filter((i) => !i.isPrimary),
      constraints,
    };
  }

  async introspectColumns(tableName: string): Promise<IntrospectedColumn[]> {
    if (this.dialect.name === 'postgresql') {
      return this.introspectPostgresColumns(tableName);
    }
    if (this.dialect.name === 'mysql') {
      return this.introspectMysqlColumns(tableName);
    }
    return this.introspectSqliteColumns(tableName);
  }

  private async introspectPostgresColumns(tableName: string): Promise<IntrospectedColumn[]> {
    const sql = `
      SELECT
        column_name,
        data_type,
        udt_name,
        is_nullable,
        column_default,
        character_maximum_length,
        numeric_precision,
        numeric_scale,
        is_identity,
        identity_generation
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
      ORDER BY ordinal_position
    `;

    const result = await this.driver.query<{
      column_name: string;
      data_type: string;
      udt_name: string;
      is_nullable: string;
      column_default: string | null;
      character_maximum_length: number | null;
      numeric_precision: number | null;
      numeric_scale: number | null;
      is_identity: string;
      identity_generation: string | null;
    }>(sql, [tableName]);

    return result.rows.map((row) => ({
      name: row.column_name,
      dataType: row.data_type,
      udtName: row.udt_name,
      isNullable: row.is_nullable === 'YES',
      defaultValue: row.column_default,
      maxLength: row.character_maximum_length,
      numericPrecision: row.numeric_precision,
      numericScale: row.numeric_scale,
      isIdentity: row.is_identity === 'YES',
      identityGeneration: row.identity_generation as 'ALWAYS' | 'BY DEFAULT' | null,
    }));
  }

  private async introspectMysqlColumns(tableName: string): Promise<IntrospectedColumn[]> {
    const sql = `
      SELECT
        column_name,
        data_type,
        column_type as udt_name,
        is_nullable,
        column_default,
        character_maximum_length,
        numeric_precision,
        numeric_scale,
        extra
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = ?
      ORDER BY ordinal_position
    `;

    const result = await this.driver.query<{
      column_name: string;
      data_type: string;
      udt_name: string;
      is_nullable: string;
      column_default: string | null;
      character_maximum_length: number | null;
      numeric_precision: number | null;
      numeric_scale: number | null;
      extra: string;
    }>(sql, [tableName]);

    return result.rows.map((row) => ({
      name: row.column_name,
      dataType: row.data_type,
      udtName: row.udt_name,
      isNullable: row.is_nullable === 'YES',
      defaultValue: row.column_default,
      maxLength: row.character_maximum_length,
      numericPrecision: row.numeric_precision,
      numericScale: row.numeric_scale,
      isIdentity: row.extra.includes('auto_increment'),
      identityGeneration: row.extra.includes('auto_increment') ? 'ALWAYS' : null,
    }));
  }

  private async introspectSqliteColumns(tableName: string): Promise<IntrospectedColumn[]> {
    const sql = `PRAGMA table_info("${tableName}")`;

    const result = await this.driver.query<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>(sql);

    return result.rows.map((row) => ({
      name: row.name,
      dataType: row.type.toLowerCase(),
      udtName: row.type.toLowerCase(),
      isNullable: row.notnull === 0,
      defaultValue: row.dflt_value,
      maxLength: null,
      numericPrecision: null,
      numericScale: null,
      isIdentity: row.pk === 1 && row.type.toLowerCase() === 'integer',
      identityGeneration: row.pk === 1 && row.type.toLowerCase() === 'integer' ? 'ALWAYS' : null,
    }));
  }

  async introspectIndexes(tableName: string): Promise<IntrospectedIndex[]> {
    if (this.dialect.name === 'postgresql') {
      return this.introspectPostgresIndexes(tableName);
    }
    if (this.dialect.name === 'mysql') {
      return this.introspectMysqlIndexes(tableName);
    }
    return this.introspectSqliteIndexes(tableName);
  }

  private async introspectPostgresIndexes(tableName: string): Promise<IntrospectedIndex[]> {
    const sql = `
      SELECT
        i.relname AS index_name,
        array_agg(a.attname ORDER BY array_position(ix.indkey, a.attnum)) AS columns,
        ix.indisunique AS is_unique,
        ix.indisprimary AS is_primary,
        am.amname AS index_type,
        pg_get_expr(ix.indexprs, ix.indrelid) AS expression
      FROM pg_index ix
      JOIN pg_class i ON ix.indexrelid = i.oid
      JOIN pg_class t ON ix.indrelid = t.oid
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
      JOIN pg_am am ON i.relam = am.oid
      WHERE t.relname = $1
        AND t.relnamespace = 'public'::regnamespace
      GROUP BY i.relname, ix.indisunique, ix.indisprimary, am.amname, ix.indexprs, ix.indrelid
    `;

    const result = await this.driver.query<{
      index_name: string;
      columns: string[];
      is_unique: boolean;
      is_primary: boolean;
      index_type: string;
      expression: string | null;
    }>(sql, [tableName]);

    return result.rows.map((row) => ({
      name: row.index_name,
      columns: row.columns,
      isUnique: row.is_unique,
      isPrimary: row.is_primary,
      type: row.index_type as IntrospectedIndex['type'],
      expression: row.expression,
    }));
  }

  private async introspectMysqlIndexes(tableName: string): Promise<IntrospectedIndex[]> {
    const sql = `
      SELECT
        index_name,
        GROUP_CONCAT(column_name ORDER BY seq_in_index) as columns,
        NOT non_unique as is_unique,
        index_name = 'PRIMARY' as is_primary,
        index_type
      FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND table_name = ?
      GROUP BY index_name, non_unique, index_type
    `;

    const result = await this.driver.query<{
      index_name: string;
      columns: string;
      is_unique: boolean;
      is_primary: boolean;
      index_type: string;
    }>(sql, [tableName]);

    return result.rows.map((row) => ({
      name: row.index_name,
      columns: row.columns.split(','),
      isUnique: row.is_unique,
      isPrimary: row.is_primary,
      type: row.index_type.toLowerCase() as IntrospectedIndex['type'],
      expression: null,
    }));
  }

  private async introspectSqliteIndexes(tableName: string): Promise<IntrospectedIndex[]> {
    const indexListSql = `PRAGMA index_list("${tableName}")`;
    const indexList = await this.driver.query<{
      seq: number;
      name: string;
      unique: number;
      origin: string;
      partial: number;
    }>(indexListSql);

    const indexes: IntrospectedIndex[] = [];

    for (const idx of indexList.rows) {
      const indexInfoSql = `PRAGMA index_info("${idx.name}")`;
      const indexInfo = await this.driver.query<{
        seqno: number;
        cid: number;
        name: string;
      }>(indexInfoSql);

      indexes.push({
        name: idx.name,
        columns: indexInfo.rows.map((row) => row.name),
        isUnique: idx.unique === 1,
        isPrimary: idx.origin === 'pk',
        type: 'btree',
        expression: null,
      });
    }

    return indexes;
  }

  async introspectForeignKeys(tableName: string): Promise<IntrospectedForeignKey[]> {
    if (this.dialect.name === 'postgresql') {
      return this.introspectPostgresForeignKeys(tableName);
    }
    if (this.dialect.name === 'mysql') {
      return this.introspectMysqlForeignKeys(tableName);
    }
    return this.introspectSqliteForeignKeys(tableName);
  }

  private async introspectPostgresForeignKeys(tableName: string): Promise<IntrospectedForeignKey[]> {
    const sql = `
      SELECT
        tc.constraint_name,
        array_agg(kcu.column_name ORDER BY kcu.ordinal_position) AS columns,
        ccu.table_name AS referenced_table,
        array_agg(ccu.column_name ORDER BY kcu.ordinal_position) AS referenced_columns,
        rc.delete_rule AS on_delete,
        rc.update_rule AS on_update
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      JOIN information_schema.referential_constraints rc
        ON rc.constraint_name = tc.constraint_name
        AND rc.constraint_schema = tc.table_schema
      WHERE tc.table_name = $1
        AND tc.table_schema = 'public'
        AND tc.constraint_type = 'FOREIGN KEY'
      GROUP BY tc.constraint_name, ccu.table_name, rc.delete_rule, rc.update_rule
    `;

    const result = await this.driver.query<{
      constraint_name: string;
      columns: string[];
      referenced_table: string;
      referenced_columns: string[];
      on_delete: string;
      on_update: string;
    }>(sql, [tableName]);

    return result.rows.map((row) => ({
      name: row.constraint_name,
      columns: row.columns,
      referencedTable: row.referenced_table,
      referencedColumns: row.referenced_columns,
      onDelete: row.on_delete as IntrospectedForeignKey['onDelete'],
      onUpdate: row.on_update as IntrospectedForeignKey['onUpdate'],
    }));
  }

  private async introspectMysqlForeignKeys(tableName: string): Promise<IntrospectedForeignKey[]> {
    const sql = `
      SELECT
        constraint_name,
        GROUP_CONCAT(column_name ORDER BY ordinal_position) as columns,
        referenced_table_name as referenced_table,
        GROUP_CONCAT(referenced_column_name ORDER BY ordinal_position) as referenced_columns
      FROM information_schema.key_column_usage
      WHERE table_schema = DATABASE()
        AND table_name = ?
        AND referenced_table_name IS NOT NULL
      GROUP BY constraint_name, referenced_table_name
    `;

    const result = await this.driver.query<{
      constraint_name: string;
      columns: string;
      referenced_table: string;
      referenced_columns: string;
    }>(sql, [tableName]);

    return result.rows.map((row) => ({
      name: row.constraint_name,
      columns: row.columns.split(','),
      referencedTable: row.referenced_table,
      referencedColumns: row.referenced_columns.split(','),
      onDelete: 'NO ACTION' as const,
      onUpdate: 'NO ACTION' as const,
    }));
  }

  private async introspectSqliteForeignKeys(tableName: string): Promise<IntrospectedForeignKey[]> {
    const sql = `PRAGMA foreign_key_list("${tableName}")`;

    const result = await this.driver.query<{
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string;
      on_update: string;
      on_delete: string;
      match: string;
    }>(sql);

    const fkMap = new Map<number, IntrospectedForeignKey>();

    for (const row of result.rows) {
      if (!fkMap.has(row.id)) {
        fkMap.set(row.id, {
          name: `fk_${tableName}_${row.id}`,
          columns: [],
          referencedTable: row.table,
          referencedColumns: [],
          onDelete: row.on_delete.replace(' ', '_') as IntrospectedForeignKey['onDelete'],
          onUpdate: row.on_update.replace(' ', '_') as IntrospectedForeignKey['onUpdate'],
        });
      }
      const fk = fkMap.get(row.id)!;
      fk.columns.push(row.from);
      fk.referencedColumns.push(row.to);
    }

    return Array.from(fkMap.values());
  }

  async introspectConstraints(tableName: string): Promise<IntrospectedConstraint[]> {
    if (this.dialect.name !== 'postgresql') {
      return [];
    }

    const sql = `
      SELECT
        con.conname AS constraint_name,
        CASE con.contype
          WHEN 'c' THEN 'CHECK'
          WHEN 'u' THEN 'UNIQUE'
          WHEN 'p' THEN 'PRIMARY KEY'
          WHEN 'f' THEN 'FOREIGN KEY'
          WHEN 'x' THEN 'EXCLUDE'
        END AS constraint_type,
        pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
      WHERE rel.relname = $1
        AND nsp.nspname = 'public'
        AND con.contype = 'c'
    `;

    const result = await this.driver.query<{
      constraint_name: string;
      constraint_type: string;
      definition: string;
    }>(sql, [tableName]);

    return result.rows.map((row) => ({
      name: row.constraint_name,
      type: row.constraint_type as IntrospectedConstraint['type'],
      definition: row.definition,
    }));
  }

  async introspectEnums(): Promise<IntrospectedEnum[]> {
    if (this.dialect.name !== 'postgresql') {
      return [];
    }

    const sql = `
      SELECT
        t.typname AS name,
        array_agg(e.enumlabel ORDER BY e.enumsortorder) AS values
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
      JOIN pg_namespace n ON t.typnamespace = n.oid
      WHERE n.nspname = 'public'
      GROUP BY t.typname
    `;

    const result = await this.driver.query<{
      name: string;
      values: string[];
    }>(sql);

    return result.rows;
  }

  async introspectExtensions(): Promise<string[]> {
    if (this.dialect.name !== 'postgresql') {
      return [];
    }

    const sql = `SELECT extname FROM pg_extension WHERE extname != 'plpgsql'`;
    const result = await this.driver.query<{ extname: string }>(sql);
    return result.rows.map((row) => row.extname);
  }

  async getDatabaseVersion(): Promise<string> {
    if (this.dialect.name === 'postgresql') {
      const result = await this.driver.query<{ version: string }>('SELECT version()');
      return result.rows[0]?.version ?? 'unknown';
    }
    if (this.dialect.name === 'mysql') {
      const result = await this.driver.query<{ version: string }>('SELECT VERSION() as version');
      return result.rows[0]?.version ?? 'unknown';
    }
    const result = await this.driver.query<{ 'sqlite_version()': string }>('SELECT sqlite_version()');
    return result.rows[0]?.['sqlite_version()'] ?? 'unknown';
  }

  private extractPrimaryKey(indexes: IntrospectedIndex[]): string[] {
    const pkIndex = indexes.find((i) => i.isPrimary);
    return pkIndex?.columns ?? [];
  }

  toSchemaDefinition(result: SchemaIntrospectionResult): SchemaDefinition {
    const tables: Record<string, TableDefinition> = {};

    for (const table of result.tables) {
      tables[table.name] = this.tableToDefinition(table);
    }

    return { tables };
  }

  private tableToDefinition(table: IntrospectedTable): TableDefinition {
    const columns: Record<string, ColumnDefinition> = {};

    for (const col of table.columns) {
      columns[col.name] = this.columnToDefinition(col, table);
    }

    const indexes = table.indexes.map((idx) => ({
      name: idx.name,
      columns: idx.columns,
      unique: idx.isUnique,
    }));

    return {
      columns,
      indexes: indexes.length > 0 ? indexes : undefined,
      primaryKey: table.primaryKey.length > 1 ? table.primaryKey : undefined,
    };
  }

  private columnToDefinition(col: IntrospectedColumn, table: IntrospectedTable): ColumnDefinition {
    const type = this.mapDataTypeToColumnType(col.dataType, col.udtName);
    const isPrimaryKey = table.primaryKey.length === 1 && table.primaryKey[0] === col.name;

    const def: ColumnDefinition = {
      type,
      nullable: col.isNullable,
    };

    if (isPrimaryKey) {
      def.primaryKey = true;
    }

    if (col.defaultValue !== null) {
      def.default = col.defaultValue;
    }

    const fk = table.foreignKeys.find((fk) => fk.columns.length === 1 && fk.columns[0] === col.name);
    if (fk) {
      def.references = {
        table: fk.referencedTable,
        column: fk.referencedColumns[0],
        onDelete: fk.onDelete,
        onUpdate: fk.onUpdate,
      };
    }

    if (col.name === 'app_id' || col.name === 'organization_id') {
      def.tenant = true;
    }

    return def;
  }

  private mapDataTypeToColumnType(dataType: string, udtName: string): ColumnType {
    const normalized = dataType.toLowerCase();
    const udt = udtName.toLowerCase();

    if (udt === 'uuid' || normalized === 'uuid') return 'uuid';
    if (normalized.includes('int') && normalized !== 'interval') return 'integer';
    if (normalized === 'bigint' || udt === 'int8') return 'bigint';
    if (normalized.includes('float') || normalized.includes('double') || normalized === 'real') return 'float';
    if (normalized.includes('numeric') || normalized.includes('decimal')) return 'decimal';
    if (normalized === 'boolean' || normalized === 'bool') return 'boolean';
    if (normalized.includes('timestamp') || normalized === 'datetime') return 'datetime';
    if (normalized === 'date') return 'date';
    if (normalized === 'time') return 'time';
    if (normalized === 'json' || normalized === 'jsonb') return 'json';
    if (normalized === 'bytea' || normalized.includes('blob') || normalized === 'binary') return 'binary';
    if (normalized === 'text' || udt === 'text') return 'text';
    return 'string';
  }
}

export function createSchemaIntrospector(driver: Driver, dialect: Dialect): SchemaIntrospector {
  return new SchemaIntrospector(driver, dialect);
}
