import type {
  ColumnDefinition,
  ColumnType,
  IndexDefinition,
  TableDefinition,
} from '../../types/index.js';
import type { Dialect } from './types.js';

const SQLITE_UUID_DEFAULT =
  "(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))))";

function compileSqliteDefault(colDef: ColumnDefinition): string {
  if (!colDef.default) return '';
  let defaultVal = colDef.default;
  if (colDef.default === 'gen_random_uuid()') {
    defaultVal = SQLITE_UUID_DEFAULT;
  } else if (colDef.default === 'now()' || colDef.default === 'NOW()') {
    defaultVal = "datetime('now')";
  }
  return ` DEFAULT ${defaultVal}`;
}

function compileSqliteConstraints(colDef: ColumnDefinition): string {
  let sql = '';
  if (colDef.primaryKey) {
    sql += ' PRIMARY KEY';
  }
  sql += compileSqliteDefault(colDef);
  if (!colDef.nullable && !colDef.primaryKey) {
    sql += ' NOT NULL';
  }
  if (colDef.unique && !colDef.primaryKey) {
    sql += ' UNIQUE';
  }
  return sql;
}

function compileSqliteReferences(colDef: ColumnDefinition): string {
  if (!colDef.references) return '';
  let sql = ` REFERENCES "${colDef.references.table}"("${colDef.references.column}")`;
  if (colDef.references.onDelete) {
    sql += ` ON DELETE ${colDef.references.onDelete}`;
  }
  return sql;
}

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
    const columnDefs = Object.entries(def.columns).map(([colName, colDef]) => {
      const typeSql = `  "${colName}" ${this.mapType(colDef.type)}`;
      const constraints = compileSqliteConstraints(colDef);
      const references = compileSqliteReferences(colDef);
      return typeSql + constraints + references;
    });

    if (def.primaryKey && def.primaryKey.length > 1) {
      columnDefs.push(`  PRIMARY KEY (${def.primaryKey.map((c) => `"${c}"`).join(', ')})`);
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
    throw new Error('SQLite does not support dropping foreign keys. Use table recreation instead.');
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
