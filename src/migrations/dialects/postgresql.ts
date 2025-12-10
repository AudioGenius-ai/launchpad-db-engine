import type {
  ColumnDefinition,
  ColumnType,
  IndexDefinition,
  TableDefinition,
} from '../../types/index.js';
import type { Dialect } from './types.js';

export const postgresDialect: Dialect = {
  name: 'postgresql',
  supportsTransactionalDDL: true,

  mapType(type: ColumnType): string {
    const map: Record<ColumnType, string> = {
      uuid: 'UUID',
      string: 'TEXT',
      text: 'TEXT',
      integer: 'INTEGER',
      bigint: 'BIGINT',
      float: 'DOUBLE PRECISION',
      decimal: 'NUMERIC',
      boolean: 'BOOLEAN',
      datetime: 'TIMESTAMPTZ',
      date: 'DATE',
      time: 'TIME',
      json: 'JSONB',
      binary: 'BYTEA',
    };
    return map[type] || 'TEXT';
  },

  createTable(name: string, def: TableDefinition): string {
    const columnDefs: string[] = [];

    for (const [colName, colDef] of Object.entries(def.columns)) {
      let sql = `  "${colName}" ${this.mapType(colDef.type)}`;

      if (colDef.primaryKey) {
        sql += ' PRIMARY KEY';
      }

      if (colDef.default) {
        sql += ` DEFAULT ${colDef.default}`;
      }

      if (!colDef.nullable && !colDef.primaryKey) {
        sql += ' NOT NULL';
      }

      if (colDef.unique && !colDef.primaryKey) {
        sql += ' UNIQUE';
      }

      if (colDef.references) {
        sql += ` REFERENCES "${colDef.references.table}"("${colDef.references.column}")`;
        if (colDef.references.onDelete) {
          sql += ` ON DELETE ${colDef.references.onDelete}`;
        }
        if (colDef.references.onUpdate) {
          sql += ` ON UPDATE ${colDef.references.onUpdate}`;
        }
      }

      columnDefs.push(sql);
    }

    if (def.primaryKey && def.primaryKey.length > 1) {
      columnDefs.push(`  PRIMARY KEY (${def.primaryKey.map((c) => `"${c}"`).join(', ')})`);
    }

    return `CREATE TABLE "${name}" (\n${columnDefs.join(',\n')}\n)`;
  },

  dropTable(name: string): string {
    return `DROP TABLE IF EXISTS "${name}" CASCADE`;
  },

  addColumn(table: string, column: string, def: ColumnDefinition): string {
    let sql = `ALTER TABLE "${table}" ADD COLUMN "${column}" ${this.mapType(def.type)}`;

    if (def.default) {
      sql += ` DEFAULT ${def.default}`;
    }

    if (!def.nullable) {
      sql += ' NOT NULL';
    }

    if (def.unique) {
      sql += ' UNIQUE';
    }

    return sql;
  },

  dropColumn(table: string, column: string): string {
    return `ALTER TABLE "${table}" DROP COLUMN "${column}"`;
  },

  alterColumn(table: string, column: string, def: ColumnDefinition): string {
    const statements: string[] = [];

    statements.push(
      `ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE ${this.mapType(def.type)}`
    );

    if (def.nullable === false) {
      statements.push(`ALTER TABLE "${table}" ALTER COLUMN "${column}" SET NOT NULL`);
    } else if (def.nullable === true) {
      statements.push(`ALTER TABLE "${table}" ALTER COLUMN "${column}" DROP NOT NULL`);
    }

    if (def.default !== undefined) {
      statements.push(`ALTER TABLE "${table}" ALTER COLUMN "${column}" SET DEFAULT ${def.default}`);
    }

    return statements.join(';\n');
  },

  createIndex(table: string, index: IndexDefinition): string {
    const indexName = index.name || `idx_${table}_${index.columns.join('_')}`;
    const unique = index.unique ? 'UNIQUE ' : '';
    const columns = index.columns.map((c) => `"${c}"`).join(', ');
    let sql = `CREATE ${unique}INDEX "${indexName}" ON "${table}" (${columns})`;

    if (index.where) {
      sql += ` WHERE ${index.where}`;
    }

    return sql;
  },

  dropIndex(name: string): string {
    return `DROP INDEX IF EXISTS "${name}"`;
  },

  addForeignKey(
    table: string,
    column: string,
    refTable: string,
    refColumn: string,
    onDelete?: string
  ): string {
    const constraintName = `fk_${table}_${column}_${refTable}`;
    let sql = `ALTER TABLE "${table}" ADD CONSTRAINT "${constraintName}" `;
    sql += `FOREIGN KEY ("${column}") REFERENCES "${refTable}"("${refColumn}")`;
    if (onDelete) {
      sql += ` ON DELETE ${onDelete}`;
    }
    return sql;
  },

  dropForeignKey(table: string, constraintName: string): string {
    return `ALTER TABLE "${table}" DROP CONSTRAINT "${constraintName}"`;
  },

  introspectTablesQuery(): string {
    return `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `;
  },

  introspectColumnsQuery(table: string): string {
    return `
      SELECT
        column_name,
        data_type,
        is_nullable,
        column_default,
        character_maximum_length
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = '${table}'
      ORDER BY ordinal_position
    `;
  },

  introspectIndexesQuery(table: string): string {
    return `
      SELECT
        i.relname as index_name,
        a.attname as column_name,
        ix.indisunique as is_unique,
        ix.indisprimary as is_primary
      FROM pg_class t
      JOIN pg_index ix ON t.oid = ix.indrelid
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
      WHERE t.relname = '${table}'
      ORDER BY i.relname, a.attnum
    `;
  },
};
