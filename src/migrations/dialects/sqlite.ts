import type { ColumnType, ColumnDefinition, TableDefinition, IndexDefinition } from '../../types/index.js';
import type { Dialect } from './types.js';

export const sqliteDialect: Dialect = {
  name: 'sqlite',
  supportsTransactionalDDL: true,

  mapType(type: ColumnType): string {
    const map: Record<ColumnType, string> = {
      uuid: 'TEXT',
      string: 'TEXT',
      text: 'TEXT',
      integer: 'INTEGER',
      bigint: 'INTEGER',
      float: 'REAL',
      decimal: 'REAL',
      boolean: 'INTEGER',
      datetime: 'TEXT',
      date: 'TEXT',
      time: 'TEXT',
      json: 'TEXT',
      binary: 'BLOB',
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
        const defaultVal = colDef.default === 'gen_random_uuid()'
          ? "(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))))"
          : colDef.default === 'now()' || colDef.default === 'NOW()'
            ? "datetime('now')"
            : colDef.default;
        sql += ` DEFAULT ${defaultVal}`;
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
      }

      columnDefs.push(sql);
    }

    if (def.primaryKey && def.primaryKey.length > 1) {
      columnDefs.push(`  PRIMARY KEY (${def.primaryKey.map(c => `"${c}"`).join(', ')})`);
    }

    return `CREATE TABLE "${name}" (\n${columnDefs.join(',\n')}\n)`;
  },

  dropTable(name: string): string {
    return `DROP TABLE IF EXISTS "${name}"`;
  },

  addColumn(table: string, column: string, def: ColumnDefinition): string {
    let sql = `ALTER TABLE "${table}" ADD COLUMN "${column}" ${this.mapType(def.type)}`;

    if (def.default) {
      sql += ` DEFAULT ${def.default}`;
    }

    return sql;
  },

  dropColumn(table: string, column: string): string {
    return `ALTER TABLE "${table}" DROP COLUMN "${column}"`;
  },

  alterColumn(_table: string, _column: string, _def: ColumnDefinition): string {
    throw new Error(
      'SQLite does not support ALTER COLUMN. Use table recreation instead: ' +
      '1. Create new table with desired schema, 2. Copy data, 3. Drop old table, 4. Rename new table'
    );
  },

  createIndex(table: string, index: IndexDefinition): string {
    const indexName = index.name || `idx_${table}_${index.columns.join('_')}`;
    const unique = index.unique ? 'UNIQUE ' : '';
    const columns = index.columns.map(c => `"${c}"`).join(', ');
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
    _table: string,
    _column: string,
    _refTable: string,
    _refColumn: string,
    _onDelete?: string
  ): string {
    throw new Error(
      'SQLite does not support adding foreign keys after table creation. ' +
      'Define foreign keys in CREATE TABLE or use table recreation.'
    );
  },

  dropForeignKey(_table: string, _constraintName: string): string {
    throw new Error(
      'SQLite does not support dropping foreign keys. Use table recreation instead.'
    );
  },

  introspectTablesQuery(): string {
    return `
      SELECT name as table_name
      FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `;
  },

  introspectColumnsQuery(table: string): string {
    return `PRAGMA table_info("${table}")`;
  },

  introspectIndexesQuery(table: string): string {
    return `PRAGMA index_list("${table}")`;
  },
};
