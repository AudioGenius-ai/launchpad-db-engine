import type { Driver } from '../driver/types.js';
import type {
  ColumnDiff,
  Conflict,
  ConstraintDiff,
  IndexDiff,
  SchemaColumnInfo,
  SchemaConstraintInfo,
  SchemaDiff,
  SchemaIndexInfo,
  SchemaInfo,
  SchemaTableInfo,
  TableDiff,
} from './types.js';

export class SchemaDiffer {
  constructor(private driver: Driver) {}

  async diff(sourceSchema: string, targetSchema: string): Promise<SchemaDiff> {
    const [sourceInfo, targetInfo] = await Promise.all([
      this.getSchemaInfo(sourceSchema),
      this.getSchemaInfo(targetSchema),
    ]);

    const tables = this.diffTables(sourceInfo, targetInfo);
    const columns = this.diffColumns(sourceInfo, targetInfo);
    const indexes = this.diffIndexes(sourceInfo, targetInfo);
    const constraints = this.diffConstraints(sourceInfo, targetInfo);
    const conflicts = this.detectConflicts(columns, constraints);

    const hasChanges =
      tables.length > 0 || columns.length > 0 || indexes.length > 0 || constraints.length > 0;

    return {
      source: sourceSchema,
      target: targetSchema,
      generatedAt: new Date(),
      hasChanges,
      canAutoMerge: conflicts.length === 0,
      tables,
      columns,
      indexes,
      constraints,
      conflicts,
      forwardSql: this.generateMigrationSql(
        sourceSchema,
        targetSchema,
        tables,
        columns,
        indexes,
        constraints,
        'forward'
      ),
      reverseSql: this.generateMigrationSql(
        targetSchema,
        sourceSchema,
        tables,
        columns,
        indexes,
        constraints,
        'reverse'
      ),
    };
  }

  private async getSchemaInfo(schemaName: string): Promise<SchemaInfo> {
    const [tables, columns, indexes, constraints] = await Promise.all([
      this.driver.query<SchemaTableInfo>(
        `
        SELECT table_name, table_type
        FROM information_schema.tables
        WHERE table_schema = $1 AND table_name NOT LIKE 'lp_%'
        ORDER BY table_name
      `,
        [schemaName]
      ),

      this.driver.query<SchemaColumnInfo>(
        `
        SELECT
          table_name, column_name, data_type,
          character_maximum_length, numeric_precision, numeric_scale,
          is_nullable, column_default, udt_name, ordinal_position
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name NOT LIKE 'lp_%'
        ORDER BY table_name, ordinal_position
      `,
        [schemaName]
      ),

      this.driver.query<SchemaIndexInfo>(
        `
        SELECT
          schemaname, tablename, indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = $1 AND tablename NOT LIKE 'lp_%'
        ORDER BY tablename, indexname
      `,
        [schemaName]
      ),

      this.driver.query<SchemaConstraintInfo>(
        `
        SELECT
          tc.table_name, tc.constraint_name, tc.constraint_type,
          kcu.column_name, ccu.table_name AS foreign_table_name,
          ccu.column_name AS foreign_column_name
        FROM information_schema.table_constraints tc
        LEFT JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        LEFT JOIN information_schema.constraint_column_usage ccu
          ON tc.constraint_name = ccu.constraint_name
          AND tc.table_schema = ccu.table_schema
        WHERE tc.table_schema = $1 AND tc.table_name NOT LIKE 'lp_%'
        ORDER BY tc.table_name, tc.constraint_name
      `,
        [schemaName]
      ),
    ]);

    return {
      tables: tables.rows,
      columns: columns.rows,
      indexes: indexes.rows,
      constraints: constraints.rows,
    };
  }

  private diffTables(source: SchemaInfo, target: SchemaInfo): TableDiff[] {
    const diffs: TableDiff[] = [];
    const sourceNames = new Set(source.tables.map((t) => t.table_name));
    const targetNames = new Set(target.tables.map((t) => t.table_name));

    for (const table of source.tables) {
      if (!targetNames.has(table.table_name)) {
        diffs.push({
          name: table.table_name,
          action: 'added',
          sourceDefinition: this.getTableDefinition(table.table_name, source),
        });
      }
    }

    for (const table of target.tables) {
      if (!sourceNames.has(table.table_name)) {
        diffs.push({
          name: table.table_name,
          action: 'removed',
          targetDefinition: this.getTableDefinition(table.table_name, target),
        });
      }
    }

    return diffs;
  }

  private diffColumns(source: SchemaInfo, target: SchemaInfo): ColumnDiff[] {
    const diffs: ColumnDiff[] = [];

    const sourceTableNames = new Set(source.tables.map((t) => t.table_name));
    const targetTableNames = new Set(target.tables.map((t) => t.table_name));

    const commonTables = [...sourceTableNames].filter((t) => targetTableNames.has(t));

    for (const tableName of commonTables) {
      const sourceCols = source.columns.filter((c) => c.table_name === tableName);
      const targetCols = target.columns.filter((c) => c.table_name === tableName);

      const sourceColMap = new Map(sourceCols.map((c) => [c.column_name, c]));
      const targetColMap = new Map(targetCols.map((c) => [c.column_name, c]));

      for (const col of sourceCols) {
        if (!targetColMap.has(col.column_name)) {
          diffs.push({
            tableName,
            columnName: col.column_name,
            action: 'added',
            sourceType: this.getColumnType(col),
            sourceNullable: col.is_nullable === 'YES',
            sourceDefault: col.column_default ?? undefined,
            isBreaking: false,
          });
        }
      }

      for (const col of targetCols) {
        if (!sourceColMap.has(col.column_name)) {
          diffs.push({
            tableName,
            columnName: col.column_name,
            action: 'removed',
            targetType: this.getColumnType(col),
            targetNullable: col.is_nullable === 'YES',
            targetDefault: col.column_default ?? undefined,
            isBreaking: true,
          });
        }
      }

      for (const col of sourceCols) {
        const targetCol = targetColMap.get(col.column_name);
        if (targetCol && this.hasColumnChanges(col, targetCol)) {
          const sourceType = this.getColumnType(col);
          const targetType = this.getColumnType(targetCol);
          const isBreaking = this.isBreakingTypeChange(sourceType, targetType);

          diffs.push({
            tableName,
            columnName: col.column_name,
            action: 'modified',
            sourceType,
            targetType,
            sourceNullable: col.is_nullable === 'YES',
            targetNullable: targetCol.is_nullable === 'YES',
            sourceDefault: col.column_default ?? undefined,
            targetDefault: targetCol.column_default ?? undefined,
            isBreaking,
          });
        }
      }
    }

    return diffs;
  }

  private diffIndexes(source: SchemaInfo, target: SchemaInfo): IndexDiff[] {
    const diffs: IndexDiff[] = [];

    const sourceMap = new Map(source.indexes.map((i) => [`${i.tablename}.${i.indexname}`, i]));
    const targetMap = new Map(target.indexes.map((i) => [`${i.tablename}.${i.indexname}`, i]));

    for (const [key, idx] of sourceMap) {
      if (!targetMap.has(key)) {
        diffs.push({
          tableName: idx.tablename,
          indexName: idx.indexname,
          action: 'added',
          sourceDefinition: idx.indexdef,
        });
      }
    }

    for (const [key, idx] of targetMap) {
      if (!sourceMap.has(key)) {
        diffs.push({
          tableName: idx.tablename,
          indexName: idx.indexname,
          action: 'removed',
          targetDefinition: idx.indexdef,
        });
      }
    }

    for (const [key, sourceIdx] of sourceMap) {
      const targetIdx = targetMap.get(key);
      if (targetIdx) {
        const normalizedSource = this.normalizeIndexDef(sourceIdx.indexdef);
        const normalizedTarget = this.normalizeIndexDef(targetIdx.indexdef);

        if (normalizedSource !== normalizedTarget) {
          diffs.push({
            tableName: sourceIdx.tablename,
            indexName: sourceIdx.indexname,
            action: 'modified',
            sourceDefinition: sourceIdx.indexdef,
            targetDefinition: targetIdx.indexdef,
          });
        }
      }
    }

    return diffs;
  }

  private diffConstraints(source: SchemaInfo, target: SchemaInfo): ConstraintDiff[] {
    const diffs: ConstraintDiff[] = [];

    const sourceMap = new Map(
      source.constraints.map((c) => [`${c.table_name}.${c.constraint_name}`, c])
    );
    const targetMap = new Map(
      target.constraints.map((c) => [`${c.table_name}.${c.constraint_name}`, c])
    );

    for (const [key, con] of sourceMap) {
      if (!targetMap.has(key)) {
        diffs.push({
          tableName: con.table_name,
          constraintName: con.constraint_name,
          constraintType: this.mapConstraintType(con.constraint_type),
          action: 'added',
          isBreaking: false,
          sourceDefinition: this.getConstraintDefinition(con),
        });
      }
    }

    for (const [key, con] of targetMap) {
      if (!sourceMap.has(key)) {
        diffs.push({
          tableName: con.table_name,
          constraintName: con.constraint_name,
          constraintType: this.mapConstraintType(con.constraint_type),
          action: 'removed',
          isBreaking: con.constraint_type !== 'CHECK',
          targetDefinition: this.getConstraintDefinition(con),
        });
      }
    }

    return diffs;
  }

  private detectConflicts(columns: ColumnDiff[], constraints: ConstraintDiff[]): Conflict[] {
    const conflicts: Conflict[] = [];

    for (const col of columns.filter((c) => c.action === 'modified')) {
      if (col.sourceType !== col.targetType) {
        conflicts.push({
          type: 'column_type_mismatch',
          description: `Column ${col.tableName}.${col.columnName} has different types: ${col.sourceType} vs ${col.targetType}`,
          sourcePath: `${col.tableName}.${col.columnName}`,
          targetPath: `${col.tableName}.${col.columnName}`,
          resolution: ['keep_source', 'keep_target', 'manual'],
        });
      }
    }

    for (const con of constraints.filter(
      (c) => c.action === 'removed' && c.constraintType === 'foreign_key'
    )) {
      conflicts.push({
        type: 'constraint_conflict',
        description: `Foreign key ${con.constraintName} on ${con.tableName} would be removed`,
        sourcePath: `${con.tableName}.${con.constraintName}`,
        targetPath: `${con.tableName}.${con.constraintName}`,
        resolution: ['keep_source', 'keep_target', 'manual'],
      });
    }

    return conflicts;
  }

  private generateMigrationSql(
    sourceSchema: string,
    targetSchema: string,
    tables: TableDiff[],
    columns: ColumnDiff[],
    indexes: IndexDiff[],
    constraints: ConstraintDiff[],
    direction: 'forward' | 'reverse'
  ): string[] {
    const sql: string[] = [];

    const schema = direction === 'forward' ? targetSchema : sourceSchema;

    for (const table of tables) {
      if (
        (direction === 'forward' && table.action === 'added') ||
        (direction === 'reverse' && table.action === 'removed')
      ) {
        if (table.sourceDefinition) {
          sql.push(table.sourceDefinition.replace(sourceSchema, schema));
        }
      } else if (
        (direction === 'forward' && table.action === 'removed') ||
        (direction === 'reverse' && table.action === 'added')
      ) {
        sql.push(`DROP TABLE IF EXISTS "${schema}"."${table.name}" CASCADE`);
      }
    }

    for (const col of columns) {
      const tableName = `"${schema}"."${col.tableName}"`;

      if (
        (direction === 'forward' && col.action === 'added') ||
        (direction === 'reverse' && col.action === 'removed')
      ) {
        const type = direction === 'forward' ? col.sourceType : col.targetType;
        sql.push(`ALTER TABLE ${tableName} ADD COLUMN "${col.columnName}" ${type}`);
      } else if (
        (direction === 'forward' && col.action === 'removed') ||
        (direction === 'reverse' && col.action === 'added')
      ) {
        sql.push(`ALTER TABLE ${tableName} DROP COLUMN IF EXISTS "${col.columnName}"`);
      } else if (col.action === 'modified') {
        const type = direction === 'forward' ? col.sourceType : col.targetType;
        sql.push(`ALTER TABLE ${tableName} ALTER COLUMN "${col.columnName}" TYPE ${type}`);
      }
    }

    for (const idx of indexes) {
      if (
        (direction === 'forward' && idx.action === 'added') ||
        (direction === 'reverse' && idx.action === 'removed')
      ) {
        const def = direction === 'forward' ? idx.sourceDefinition : idx.targetDefinition;
        if (def) {
          sql.push(def.replace(sourceSchema, schema).replace(targetSchema, schema));
        }
      } else if (
        (direction === 'forward' && idx.action === 'removed') ||
        (direction === 'reverse' && idx.action === 'added')
      ) {
        sql.push(`DROP INDEX IF EXISTS "${schema}"."${idx.indexName}"`);
      }
    }

    for (const con of constraints) {
      const tableName = `"${schema}"."${con.tableName}"`;

      if (
        (direction === 'forward' && con.action === 'added') ||
        (direction === 'reverse' && con.action === 'removed')
      ) {
        const def = direction === 'forward' ? con.sourceDefinition : con.targetDefinition;
        if (def) {
          sql.push(`ALTER TABLE ${tableName} ADD ${def}`);
        }
      } else if (
        (direction === 'forward' && con.action === 'removed') ||
        (direction === 'reverse' && con.action === 'added')
      ) {
        sql.push(`ALTER TABLE ${tableName} DROP CONSTRAINT IF EXISTS "${con.constraintName}"`);
      }
    }

    return sql;
  }

  private getTableDefinition(tableName: string, schema: SchemaInfo): string {
    const columns = schema.columns.filter((c) => c.table_name === tableName);
    const colDefs = columns.map((c) => {
      let def = `"${c.column_name}" ${this.getColumnType(c)}`;
      if (c.is_nullable === 'NO') {
        def += ' NOT NULL';
      }
      if (c.column_default) {
        def += ` DEFAULT ${c.column_default}`;
      }
      return def;
    });

    return `CREATE TABLE "${tableName}" (\n  ${colDefs.join(',\n  ')}\n)`;
  }

  private getColumnType(col: SchemaColumnInfo): string {
    let type = col.data_type;

    if (col.character_maximum_length) {
      type = `${col.udt_name}(${col.character_maximum_length})`;
    } else if (col.numeric_precision && col.numeric_scale !== null) {
      type = `${col.udt_name}(${col.numeric_precision},${col.numeric_scale})`;
    } else if (col.udt_name && col.udt_name !== col.data_type) {
      type = col.udt_name;
    }

    return type.toUpperCase();
  }

  private hasColumnChanges(source: SchemaColumnInfo, target: SchemaColumnInfo): boolean {
    return (
      this.getColumnType(source) !== this.getColumnType(target) ||
      source.is_nullable !== target.is_nullable ||
      source.column_default !== target.column_default
    );
  }

  private isBreakingTypeChange(sourceType: string, targetType: string): boolean {
    const breakingChanges = [
      { from: 'TEXT', to: 'VARCHAR' },
      { from: 'VARCHAR', to: 'INTEGER' },
      { from: 'INTEGER', to: 'SMALLINT' },
      { from: 'BIGINT', to: 'INTEGER' },
      { from: 'TIMESTAMP', to: 'DATE' },
    ];

    const source = sourceType.toUpperCase();
    const target = targetType.toUpperCase();

    return breakingChanges.some(
      (change) => source.includes(change.from) && target.includes(change.to)
    );
  }

  private normalizeIndexDef(indexdef: string): string {
    return indexdef
      .replace(/\s+/g, ' ')
      .replace(/\s*,\s*/g, ', ')
      .toLowerCase()
      .trim();
  }

  private mapConstraintType(type: string): 'primary_key' | 'foreign_key' | 'unique' | 'check' {
    switch (type) {
      case 'PRIMARY KEY':
        return 'primary_key';
      case 'FOREIGN KEY':
        return 'foreign_key';
      case 'UNIQUE':
        return 'unique';
      case 'CHECK':
        return 'check';
      default:
        return 'check';
    }
  }

  private getConstraintDefinition(con: SchemaConstraintInfo): string {
    if (
      con.constraint_type === 'FOREIGN KEY' &&
      con.foreign_table_name &&
      con.foreign_column_name
    ) {
      return `CONSTRAINT "${con.constraint_name}" FOREIGN KEY ("${con.column_name}") REFERENCES "${con.foreign_table_name}"("${con.foreign_column_name}")`;
    }
    if (con.constraint_type === 'PRIMARY KEY') {
      return `CONSTRAINT "${con.constraint_name}" PRIMARY KEY ("${con.column_name}")`;
    }
    if (con.constraint_type === 'UNIQUE') {
      return `CONSTRAINT "${con.constraint_name}" UNIQUE ("${con.column_name}")`;
    }
    return `CONSTRAINT "${con.constraint_name}"`;
  }
}
