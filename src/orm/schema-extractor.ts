import type {
  ColumnDefinition,
  IndexDefinition,
  SchemaDefinition,
  TableDefinition,
} from '../types/index.js';
import { type EntityConstructor, type EntityMetadata, metadataStorage } from './metadata.js';

export interface ExtractSchemaOptions {
  entities: EntityConstructor[];
}

export function extractSchemaFromEntities(entities: EntityConstructor[]): SchemaDefinition {
  const tables: Record<string, TableDefinition> = {};

  for (const entity of entities) {
    const metadata = metadataStorage.getEntityMetadata(entity);
    if (!metadata) {
      throw new Error(`Entity ${entity.name} is not decorated with @Entity`);
    }

    tables[metadata.tableName] = extractTableDefinition(metadata);
  }

  return { tables };
}

export function extractSchemaFromEntity(entity: EntityConstructor): SchemaDefinition {
  return extractSchemaFromEntities([entity]);
}

export function extractTableDefinition(metadata: EntityMetadata): TableDefinition {
  const columns: Record<string, ColumnDefinition> = {};
  const primaryKeyColumns: string[] = [];

  for (const [, columnMeta] of metadata.columns) {
    const columnDef: ColumnDefinition = {
      type: columnMeta.type,
      nullable: columnMeta.nullable,
    };

    if (columnMeta.primaryKey) {
      columnDef.primaryKey = true;
      primaryKeyColumns.push(columnMeta.columnName);
    }

    if (columnMeta.unique) {
      columnDef.unique = true;
    }

    if (columnMeta.default) {
      columnDef.default = columnMeta.default;
    }

    if (columnMeta.tenant) {
      columnDef.tenant = true;
    }

    if (columnMeta.references) {
      columnDef.references = columnMeta.references;
    }

    columns[columnMeta.columnName] = columnDef;
  }

  const indexes: IndexDefinition[] = metadata.indexes.map((idx) => ({
    name: idx.name,
    columns: idx.columns,
    unique: idx.unique,
    where: idx.where,
  }));

  const tableDef: TableDefinition = {
    columns,
  };

  if (indexes.length > 0) {
    tableDef.indexes = indexes;
  }

  if (primaryKeyColumns.length > 1) {
    tableDef.primaryKey = primaryKeyColumns;
  }

  return tableDef;
}

export function getEntityTableName(entity: EntityConstructor): string {
  const metadata = metadataStorage.getEntityMetadata(entity);
  if (!metadata) {
    throw new Error(`Entity ${entity.name} is not decorated with @Entity`);
  }
  return metadata.tableName;
}

export function getEntityColumns(entity: EntityConstructor): Map<string, string> {
  const metadata = metadataStorage.getEntityMetadata(entity);
  if (!metadata) {
    throw new Error(`Entity ${entity.name} is not decorated with @Entity`);
  }

  const columnMap = new Map<string, string>();
  for (const [propertyName, columnMeta] of metadata.columns) {
    columnMap.set(propertyName, columnMeta.columnName);
  }
  return columnMap;
}

export function propertyToColumn(entity: EntityConstructor, propertyName: string): string {
  const metadata = metadataStorage.getEntityMetadata(entity);
  if (!metadata) {
    throw new Error(`Entity ${entity.name} is not decorated with @Entity`);
  }

  const column = metadata.columns.get(propertyName);
  if (!column) {
    throw new Error(`Property ${propertyName} not found on entity ${entity.name}`);
  }

  return column.columnName;
}

export function columnToProperty(entity: EntityConstructor, columnName: string): string {
  const metadata = metadataStorage.getEntityMetadata(entity);
  if (!metadata) {
    throw new Error(`Entity ${entity.name} is not decorated with @Entity`);
  }

  for (const [propertyName, columnMeta] of metadata.columns) {
    if (columnMeta.columnName === columnName) {
      return propertyName;
    }
  }

  throw new Error(`Column ${columnName} not found on entity ${entity.name}`);
}
