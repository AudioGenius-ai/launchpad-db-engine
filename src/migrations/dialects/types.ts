import type { ColumnType, ColumnDefinition, TableDefinition, IndexDefinition } from '../../types/index.js';

export interface Dialect {
  name: 'postgresql' | 'mysql' | 'sqlite';

  mapType(type: ColumnType): string;

  createTable(name: string, def: TableDefinition): string;
  dropTable(name: string): string;

  addColumn(table: string, column: string, def: ColumnDefinition): string;
  dropColumn(table: string, column: string): string;
  alterColumn(table: string, column: string, def: ColumnDefinition): string;

  createIndex(table: string, index: IndexDefinition): string;
  dropIndex(name: string, table?: string): string;

  addForeignKey(
    table: string,
    column: string,
    refTable: string,
    refColumn: string,
    onDelete?: string
  ): string;
  dropForeignKey(table: string, constraintName: string): string;

  supportsTransactionalDDL: boolean;

  introspectTablesQuery(): string;
  introspectColumnsQuery(table: string): string;
  introspectIndexesQuery(table: string): string;
}
