import type { ColumnType, IndexDefinition } from '../types/index.js';

export interface EntityMetadata {
  tableName: string;
  columns: Map<string, ColumnMetadata>;
  indexes: IndexDefinition[];
  relations: Map<string, RelationMetadata>;
}

export interface ColumnMetadata {
  propertyName: string;
  columnName: string;
  type: ColumnType;
  primaryKey: boolean;
  nullable: boolean;
  unique: boolean;
  default?: string;
  tenant: boolean;
  references?: {
    table: string;
    column: string;
    onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
    onUpdate?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
  };
}

export interface RelationMetadata {
  propertyName: string;
  type: 'one-to-many' | 'many-to-one' | 'one-to-one' | 'many-to-many';
  target: () => Function;
  inverseSide?: string;
  foreignKey?: string;
  joinTable?: string;
}

export type EntityConstructor<T = unknown> = new (...args: unknown[]) => T;

class MetadataStorage {
  private entities: Map<Function, EntityMetadata> = new Map();

  registerEntity(target: Function, tableName: string): void {
    if (!this.entities.has(target)) {
      this.entities.set(target, {
        tableName,
        columns: new Map(),
        indexes: [],
        relations: new Map(),
      });
    } else {
      const metadata = this.entities.get(target)!;
      metadata.tableName = tableName;
    }
  }

  registerColumn(target: Function, propertyName: string, metadata: Partial<ColumnMetadata>): void {
    this.ensureEntity(target);
    const entity = this.entities.get(target)!;

    const existing = entity.columns.get(propertyName) || {
      propertyName,
      columnName: this.toSnakeCase(propertyName),
      type: 'string' as ColumnType,
      primaryKey: false,
      nullable: true,
      unique: false,
      tenant: false,
    };

    entity.columns.set(propertyName, { ...existing, ...metadata });
  }

  registerRelation(target: Function, propertyName: string, metadata: RelationMetadata): void {
    this.ensureEntity(target);
    const entity = this.entities.get(target)!;
    entity.relations.set(propertyName, metadata);
  }

  registerIndex(target: Function, index: IndexDefinition): void {
    this.ensureEntity(target);
    const entity = this.entities.get(target)!;
    entity.indexes.push(index);
  }

  getEntityMetadata(target: Function): EntityMetadata | undefined {
    return this.entities.get(target);
  }

  getAllEntities(): Map<Function, EntityMetadata> {
    return this.entities;
  }

  hasEntity(target: Function): boolean {
    return this.entities.has(target);
  }

  private ensureEntity(target: Function): void {
    if (!this.entities.has(target)) {
      this.entities.set(target, {
        tableName: this.toSnakeCase(target.name),
        columns: new Map(),
        indexes: [],
        relations: new Map(),
      });
    }
  }

  private toSnakeCase(str: string): string {
    return str.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
  }

  clear(): void {
    this.entities.clear();
  }
}

export const metadataStorage = new MetadataStorage();
