import type {
  ColumnDefinition,
  ColumnType,
  IndexDefinition,
  TableDefinition,
} from '../../types/index.js';
import type { Dialect } from './types.js';

function compileMysqlDefault(colDef: ColumnDefinition): string {
  if (!colDef.default) return '';
  const defaultVal = colDef.default === 'gen_random_uuid()' ? '(UUID())' : colDef.default;
  return ` DEFAULT ${defaultVal}`;
}

function compileMysqlConstraints(colDef: ColumnDefinition): string {
  let sql = '';
  if (colDef.primaryKey) {
    sql += ' PRIMARY KEY';
  }
  sql += compileMysqlDefault(colDef);
  if (!colDef.nullable && !colDef.primaryKey) {
    sql += ' NOT NULL';
  }
  if (colDef.unique && !colDef.primaryKey) {
    sql += ' UNIQUE';
  }
  return sql;
}

function compileMysqlForeignKeys(
  tableName: string,
  columns: Record<string, ColumnDefinition>
): string[] {
  const fkDefs: string[] = [];
  for (const [colName, colDef] of Object.entries(columns)) {
    if (colDef.references) {
      const fkName = `fk_${tableName}_${colName}`;
      let fk = `  CONSTRAINT \`${fkName}\` FOREIGN KEY (\`${colName}\`) `;
      fk += `REFERENCES \`${colDef.references.table}\`(\`${colDef.references.column}\`)`;
      if (colDef.references.onDelete) {
        fk += ` ON DELETE ${colDef.references.onDelete}`;
      }
      fkDefs.push(fk);
    }
  }
  return fkDefs;
}

export const mysqlDialect: Dialect = {
  name: 'mysql',
  supportsTransactionalDDL: false,

  mapType(type: ColumnType): string {
    const map: Record<ColumnType, string> = {
      uuid: 'CHAR(36)',
      string: 'VARCHAR(255)',
      text: 'TEXT',
      integer: 'INT',
      bigint: 'BIGINT',
      float: 'DOUBLE',
      decimal: 'DECIMAL(10,2)',
      boolean: 'TINYINT(1)',
      datetime: 'DATETIME',
      date: 'DATE',
      time: 'TIME',
      json: 'JSON',
      binary: 'BLOB',
    };
    return map[type] || 'VARCHAR(255)';
  },

  createTable(name: string, def: TableDefinition): string {
    const columnDefs = Object.entries(def.columns).map(([colName, colDef]) => {
      const typeSql = `  \`${colName}\` ${this.mapType(colDef.type)}`;
      return typeSql + compileMysqlConstraints(colDef);
    });

    if (def.primaryKey && def.primaryKey.length > 1) {
      columnDefs.push(`  PRIMARY KEY (${def.primaryKey.map((c) => `\`${c}\``).join(', ')})`);
    }

    const foreignKeys = compileMysqlForeignKeys(name, def.columns);
    columnDefs.push(...foreignKeys);

    return `CREATE TABLE \`${name}\` (\n${columnDefs.join(',\n')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
  },

  dropTable(name: string): string {
    return `DROP TABLE IF EXISTS \`${name}\``;
  },

  addColumn(table: string, column: string, def: ColumnDefinition): string {
    let sql = `ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${this.mapType(def.type)}`;

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
    return `ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``;
  },

  alterColumn(table: string, column: string, def: ColumnDefinition): string {
    let sql = `ALTER TABLE \`${table}\` MODIFY COLUMN \`${column}\` ${this.mapType(def.type)}`;

    if (def.default) {
      sql += ` DEFAULT ${def.default}`;
    }

    if (!def.nullable) {
      sql += ' NOT NULL';
    }

    return sql;
  },

  createIndex(table: string, index: IndexDefinition): string {
    const indexName = index.name || `idx_${table}_${index.columns.join('_')}`;
    const unique = index.unique ? 'UNIQUE ' : '';
    const columns = index.columns.map((c) => `\`${c}\``).join(', ');
    return `CREATE ${unique}INDEX \`${indexName}\` ON \`${table}\` (${columns})`;
  },

  dropIndex(name: string, table?: string): string {
    if (!table) {
      throw new Error('MySQL requires table name for DROP INDEX');
    }
    return `DROP INDEX \`${name}\` ON \`${table}\``;
  },

  addForeignKey(
    table: string,
    column: string,
    refTable: string,
    refColumn: string,
    onDelete?: string
  ): string {
    const constraintName = `fk_${table}_${column}_${refTable}`;
    let sql = `ALTER TABLE \`${table}\` ADD CONSTRAINT \`${constraintName}\` `;
    sql += `FOREIGN KEY (\`${column}\`) REFERENCES \`${refTable}\`(\`${refColumn}\`)`;
    if (onDelete) {
      sql += ` ON DELETE ${onDelete}`;
    }
    return sql;
  },

  dropForeignKey(table: string, constraintName: string): string {
    return `ALTER TABLE \`${table}\` DROP FOREIGN KEY \`${constraintName}\``;
  },

  introspectTablesQuery(): string {
    return `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = DATABASE()
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
      WHERE table_schema = DATABASE() AND table_name = '${table}'
      ORDER BY ordinal_position
    `;
  },

  introspectIndexesQuery(table: string): string {
    return `
      SELECT
        index_name,
        column_name,
        non_unique
      FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = '${table}'
      ORDER BY index_name, seq_in_index
    `;
  },
};
