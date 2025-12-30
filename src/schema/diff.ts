import { createHash } from 'node:crypto';
import type { Dialect } from '../migrations/dialects/types.js';
import type { ColumnDefinition, IndexDefinition, SchemaDefinition, TableDefinition } from '../types/index.js';
import type {
  DiffSummary,
  MigrationScript,
  SchemaChange,
  SchemaDiff,
} from './types.js';

export interface SchemaDiffOptions {
  generateMigration?: boolean;
  treatColumnDropAsBreaking?: boolean;
  treatTableDropAsBreaking?: boolean;
  migrationName?: string;
}

export class SchemaDiffEngine {
  constructor(private dialect: Dialect) {}

  computeDiff(
    current: SchemaDefinition | null,
    target: SchemaDefinition,
    options: SchemaDiffOptions = {}
  ): SchemaDiff {
    const changes: SchemaChange[] = [];
    const currentTables = new Set(Object.keys(current?.tables ?? {}));
    const targetTables = new Set(Object.keys(target.tables));

    for (const tableName of targetTables) {
      if (!currentTables.has(tableName)) {
        const tableChanges = this.generateTableAddChanges(tableName, target.tables[tableName]);
        changes.push(...tableChanges);
      }
    }

    for (const tableName of currentTables) {
      if (!targetTables.has(tableName)) {
        changes.push(this.generateTableDropChange(tableName, current!.tables[tableName], options));
      }
    }

    for (const tableName of currentTables) {
      if (targetTables.has(tableName)) {
        const columnChanges = this.compareColumns(
          tableName,
          current!.tables[tableName],
          target.tables[tableName],
          options
        );
        changes.push(...columnChanges);

        const indexChanges = this.compareIndexes(
          tableName,
          current!.tables[tableName],
          target.tables[tableName]
        );
        changes.push(...indexChanges);
      }
    }

    const breakingChanges = changes.filter((c) => c.isBreaking);
    const summary = this.summarizeChanges(changes);

    let migration: MigrationScript | null = null;
    if (options.generateMigration !== false && changes.length > 0) {
      migration = this.generateMigration(changes, options.migrationName);
    }

    return {
      hasDifferences: changes.length > 0,
      summary,
      changes,
      breakingChanges,
      migration,
    };
  }

  private generateTableAddChanges(tableName: string, table: TableDefinition): SchemaChange[] {
    const changes: SchemaChange[] = [];

    const createSql = this.dialect.createTable(tableName, table);
    const dropSql = this.dialect.dropTable(tableName);

    changes.push({
      type: 'table_add',
      tableName,
      isBreaking: false,
      description: `Add table "${tableName}"`,
      upSql: createSql,
      downSql: dropSql,
    });

    if (table.indexes) {
      for (const index of table.indexes) {
        const indexSql = this.dialect.createIndex(tableName, index);
        const dropIndexSql = this.dialect.dropIndex(index.name ?? `idx_${tableName}_${index.columns.join('_')}`);

        changes.push({
          type: 'index_add',
          tableName,
          objectName: index.name ?? `idx_${tableName}_${index.columns.join('_')}`,
          isBreaking: false,
          description: `Add index on "${tableName}"(${index.columns.join(', ')})`,
          upSql: indexSql,
          downSql: dropIndexSql,
        });
      }
    }

    return changes;
  }

  private generateTableDropChange(
    tableName: string,
    table: TableDefinition,
    options: SchemaDiffOptions
  ): SchemaChange {
    const dropSql = this.dialect.dropTable(tableName);
    const createSql = this.dialect.createTable(tableName, table);

    return {
      type: 'table_drop',
      tableName,
      isBreaking: options.treatTableDropAsBreaking !== false,
      description: `Drop table "${tableName}"`,
      upSql: dropSql,
      downSql: createSql,
      oldValue: table,
    };
  }

  private compareColumns(
    tableName: string,
    current: TableDefinition,
    target: TableDefinition,
    options: SchemaDiffOptions
  ): SchemaChange[] {
    const changes: SchemaChange[] = [];
    const currentCols = new Set(Object.keys(current.columns));
    const targetCols = new Set(Object.keys(target.columns));

    for (const colName of targetCols) {
      if (!currentCols.has(colName)) {
        const colDef = target.columns[colName];
        const addSql = this.dialect.addColumn(tableName, colName, colDef);
        const dropSql = this.dialect.dropColumn(tableName, colName);

        changes.push({
          type: 'column_add',
          tableName,
          objectName: colName,
          isBreaking: false,
          description: `Add column "${tableName}"."${colName}"`,
          upSql: addSql,
          downSql: dropSql,
          newValue: colDef,
        });

        if (colDef.references) {
          const fkName = `fk_${tableName}_${colName}_${colDef.references.table}`;
          const addFkSql = this.dialect.addForeignKey(
            tableName,
            colName,
            colDef.references.table,
            colDef.references.column,
            colDef.references.onDelete
          );
          const dropFkSql = this.dialect.dropForeignKey(tableName, fkName);

          changes.push({
            type: 'foreign_key_add',
            tableName,
            objectName: fkName,
            isBreaking: false,
            description: `Add foreign key "${tableName}"."${colName}" -> "${colDef.references.table}"`,
            upSql: addFkSql,
            downSql: dropFkSql,
            newValue: colDef.references,
          });
        }
      }
    }

    for (const colName of currentCols) {
      if (!targetCols.has(colName)) {
        const colDef = current.columns[colName];
        const dropSql = this.dialect.dropColumn(tableName, colName);
        const addSql = this.dialect.addColumn(tableName, colName, colDef);

        changes.push({
          type: 'column_drop',
          tableName,
          objectName: colName,
          isBreaking: options.treatColumnDropAsBreaking !== false,
          description: `Drop column "${tableName}"."${colName}"`,
          upSql: dropSql,
          downSql: addSql,
          oldValue: colDef,
        });
      }
    }

    for (const colName of currentCols) {
      if (targetCols.has(colName)) {
        const currentCol = current.columns[colName];
        const targetCol = target.columns[colName];

        if (!this.columnsEqual(currentCol, targetCol)) {
          const alteration = this.generateColumnAlteration(tableName, colName, currentCol, targetCol);
          if (alteration) {
            changes.push(alteration);
          }
        }
      }
    }

    return changes;
  }

  private compareIndexes(
    tableName: string,
    current: TableDefinition,
    target: TableDefinition
  ): SchemaChange[] {
    const changes: SchemaChange[] = [];

    const currentIndexes = new Map<string, IndexDefinition>();
    const targetIndexes = new Map<string, IndexDefinition>();

    for (const idx of current.indexes ?? []) {
      const key = idx.name ?? `idx_${tableName}_${idx.columns.join('_')}`;
      currentIndexes.set(key, idx);
    }

    for (const idx of target.indexes ?? []) {
      const key = idx.name ?? `idx_${tableName}_${idx.columns.join('_')}`;
      targetIndexes.set(key, idx);
    }

    for (const [name, idx] of targetIndexes) {
      if (!currentIndexes.has(name)) {
        const addSql = this.dialect.createIndex(tableName, idx);
        const dropSql = this.dialect.dropIndex(name);

        changes.push({
          type: 'index_add',
          tableName,
          objectName: name,
          isBreaking: false,
          description: `Add index "${name}" on "${tableName}"`,
          upSql: addSql,
          downSql: dropSql,
          newValue: idx,
        });
      }
    }

    for (const [name, idx] of currentIndexes) {
      if (!targetIndexes.has(name)) {
        const dropSql = this.dialect.dropIndex(name);
        const addSql = this.dialect.createIndex(tableName, idx);

        changes.push({
          type: 'index_drop',
          tableName,
          objectName: name,
          isBreaking: false,
          description: `Drop index "${name}" from "${tableName}"`,
          upSql: dropSql,
          downSql: addSql,
          oldValue: idx,
        });
      }
    }

    return changes;
  }

  private generateColumnAlteration(
    tableName: string,
    colName: string,
    current: ColumnDefinition,
    target: ColumnDefinition
  ): SchemaChange | null {
    const isBreaking = this.isColumnChangeBreaking(current, target);

    try {
      const alterSql = this.dialect.alterColumn(tableName, colName, target);
      const revertSql = this.dialect.alterColumn(tableName, colName, current);

      return {
        type: 'column_modify',
        tableName,
        objectName: colName,
        isBreaking,
        description: `Modify column "${tableName}"."${colName}"`,
        upSql: alterSql,
        downSql: revertSql,
        oldValue: current,
        newValue: target,
      };
    } catch {
      return null;
    }
  }

  private isColumnChangeBreaking(current: ColumnDefinition, target: ColumnDefinition): boolean {
    if (target.nullable === false && current.nullable === true) {
      return true;
    }

    const typeOrder: Record<string, number> = {
      uuid: 10,
      boolean: 20,
      integer: 30,
      bigint: 40,
      float: 50,
      decimal: 60,
      string: 70,
      text: 80,
      date: 90,
      time: 100,
      datetime: 110,
      json: 120,
      binary: 130,
    };

    const currentOrder = typeOrder[current.type] ?? 0;
    const targetOrder = typeOrder[target.type] ?? 0;

    if (targetOrder < currentOrder) {
      return true;
    }

    return false;
  }

  private columnsEqual(a: ColumnDefinition, b: ColumnDefinition): boolean {
    return (
      a.type === b.type &&
      (a.nullable ?? false) === (b.nullable ?? false) &&
      (a.unique ?? false) === (b.unique ?? false) &&
      a.default === b.default &&
      JSON.stringify(a.references) === JSON.stringify(b.references)
    );
  }

  private summarizeChanges(changes: SchemaChange[]): DiffSummary {
    const summary: DiffSummary = {
      tablesAdded: 0,
      tablesDropped: 0,
      tablesModified: 0,
      columnsAdded: 0,
      columnsDropped: 0,
      columnsModified: 0,
      indexesAdded: 0,
      indexesDropped: 0,
      foreignKeysAdded: 0,
      foreignKeysDropped: 0,
    };

    const modifiedTables = new Set<string>();

    for (const change of changes) {
      switch (change.type) {
        case 'table_add':
          summary.tablesAdded++;
          break;
        case 'table_drop':
          summary.tablesDropped++;
          break;
        case 'column_add':
          summary.columnsAdded++;
          modifiedTables.add(change.tableName);
          break;
        case 'column_drop':
          summary.columnsDropped++;
          modifiedTables.add(change.tableName);
          break;
        case 'column_modify':
          summary.columnsModified++;
          modifiedTables.add(change.tableName);
          break;
        case 'index_add':
          summary.indexesAdded++;
          break;
        case 'index_drop':
          summary.indexesDropped++;
          break;
        case 'foreign_key_add':
          summary.foreignKeysAdded++;
          break;
        case 'foreign_key_drop':
          summary.foreignKeysDropped++;
          break;
      }
    }

    summary.tablesModified = modifiedTables.size;

    return summary;
  }

  private generateMigration(changes: SchemaChange[], name?: string): MigrationScript {
    const timestamp = new Date()
      .toISOString()
      .replace(/[-:T.Z]/g, '')
      .slice(0, 14);

    const migrationName = name ?? 'schema_sync';
    const version = `${timestamp}`;

    const upSql = changes.map((c) => c.upSql);
    const downSql = changes
      .slice()
      .reverse()
      .map((c) => c.downSql);

    const content = [...upSql, ...downSql].join('\n');
    const checksum = createHash('sha256').update(content).digest('hex');

    return {
      version,
      name: migrationName,
      upSql,
      downSql,
      checksum,
    };
  }

  formatDiff(diff: SchemaDiff, format: 'text' | 'json' | 'sql' = 'text'): string {
    if (format === 'json') {
      return JSON.stringify(diff, null, 2);
    }

    if (format === 'sql') {
      if (!diff.migration) return '-- No changes';
      return `-- Up\n${diff.migration.upSql.join(';\n')};\n\n-- Down\n${diff.migration.downSql.join(';\n')};`;
    }

    const lines: string[] = [];

    lines.push('┌──────────────────────────────────────────────────────────────────┐');
    lines.push('│                     Schema Diff: local ↔ remote                  │');
    lines.push('├──────────────────────────────────────────────────────────────────┤');

    if (!diff.hasDifferences) {
      lines.push('│  No differences found                                            │');
      lines.push('└──────────────────────────────────────────────────────────────────┘');
      return lines.join('\n');
    }

    lines.push('│ Summary:                                                          │');
    if (diff.summary.tablesAdded > 0) {
      lines.push(`│   + ${diff.summary.tablesAdded} table(s) added                                             │`);
    }
    if (diff.summary.tablesDropped > 0) {
      lines.push(`│   - ${diff.summary.tablesDropped} table(s) dropped (BREAKING)                               │`);
    }
    if (diff.summary.columnsAdded > 0) {
      lines.push(`│   + ${diff.summary.columnsAdded} column(s) added                                            │`);
    }
    if (diff.summary.columnsDropped > 0) {
      lines.push(`│   - ${diff.summary.columnsDropped} column(s) dropped (BREAKING)                              │`);
    }
    if (diff.summary.columnsModified > 0) {
      lines.push(`│   ~ ${diff.summary.columnsModified} column(s) modified                                        │`);
    }
    if (diff.summary.indexesAdded > 0) {
      lines.push(`│   + ${diff.summary.indexesAdded} index(es) added                                             │`);
    }
    if (diff.summary.indexesDropped > 0) {
      lines.push(`│   - ${diff.summary.indexesDropped} index(es) dropped                                          │`);
    }

    lines.push('├──────────────────────────────────────────────────────────────────┤');

    for (const change of diff.changes) {
      const prefix = change.type.includes('add') ? '+' : change.type.includes('drop') ? '-' : '~';
      const breaking = change.isBreaking ? ' (BREAKING)' : '';
      lines.push(`│ ${prefix} ${change.description}${breaking}`);
    }

    lines.push('└──────────────────────────────────────────────────────────────────┘');

    if (diff.breakingChanges.length > 0) {
      lines.push('');
      lines.push(`⚠️  ${diff.breakingChanges.length} breaking change(s) detected. Use --force to apply.`);
    }

    return lines.join('\n');
  }
}

export function createSchemaDiffEngine(dialect: Dialect): SchemaDiffEngine {
  return new SchemaDiffEngine(dialect);
}
