import type { ColumnType } from '../types/index.js';
import { metadataStorage } from './metadata.js';

export interface ColumnOptions {
  name?: string;
  nullable?: boolean;
  unique?: boolean;
  default?: string;
  references?: {
    table: string;
    column: string;
    onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
    onUpdate?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
  };
}

export interface EntityOptions {
  name?: string;
}

export interface IndexOptions {
  name?: string;
  columns: string[];
  unique?: boolean;
  where?: string;
}

export function Entity(tableNameOrOptions?: string | EntityOptions): ClassDecorator {
  return (target: Function) => {
    const tableName =
      typeof tableNameOrOptions === 'string'
        ? tableNameOrOptions
        : tableNameOrOptions?.name || toSnakeCase(target.name);

    metadataStorage.registerEntity(target, tableName);
  };
}

export function Column(type: ColumnType, options?: ColumnOptions): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    const propertyName = String(propertyKey);
    metadataStorage.registerColumn(target.constructor, propertyName, {
      propertyName,
      columnName: options?.name || toSnakeCase(propertyName),
      type,
      nullable: options?.nullable ?? true,
      unique: options?.unique ?? false,
      default: options?.default,
      references: options?.references,
      primaryKey: false,
      tenant: false,
    });
  };
}

export function PrimaryKey(): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    const propertyName = String(propertyKey);
    metadataStorage.registerColumn(target.constructor, propertyName, {
      primaryKey: true,
      nullable: false,
    });
  };
}

export function TenantColumn(): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    const propertyName = String(propertyKey);
    metadataStorage.registerColumn(target.constructor, propertyName, {
      tenant: true,
      nullable: false,
    });
  };
}

export function Unique(): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    const propertyName = String(propertyKey);
    metadataStorage.registerColumn(target.constructor, propertyName, {
      unique: true,
    });
  };
}

export function Nullable(): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    const propertyName = String(propertyKey);
    metadataStorage.registerColumn(target.constructor, propertyName, {
      nullable: true,
    });
  };
}

export function Default(value: string): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    const propertyName = String(propertyKey);
    metadataStorage.registerColumn(target.constructor, propertyName, {
      default: value,
    });
  };
}

export function Index(options: IndexOptions): ClassDecorator {
  return (target: Function) => {
    metadataStorage.registerIndex(target, {
      name: options.name,
      columns: options.columns,
      unique: options.unique,
      where: options.where,
    });
  };
}

export function OneToMany(target: () => Function, inverseSide: string): PropertyDecorator {
  return (targetClass: object, propertyKey: string | symbol) => {
    const propertyName = String(propertyKey);
    metadataStorage.registerRelation(targetClass.constructor, propertyName, {
      propertyName,
      type: 'one-to-many',
      target,
      inverseSide,
    });
  };
}

export function ManyToOne(
  target: () => Function,
  options?: { foreignKey?: string }
): PropertyDecorator {
  return (targetClass: object, propertyKey: string | symbol) => {
    const propertyName = String(propertyKey);
    metadataStorage.registerRelation(targetClass.constructor, propertyName, {
      propertyName,
      type: 'many-to-one',
      target,
      foreignKey: options?.foreignKey,
    });
  };
}

export function OneToOne(
  target: () => Function,
  options?: { foreignKey?: string; inverseSide?: string }
): PropertyDecorator {
  return (targetClass: object, propertyKey: string | symbol) => {
    const propertyName = String(propertyKey);
    metadataStorage.registerRelation(targetClass.constructor, propertyName, {
      propertyName,
      type: 'one-to-one',
      target,
      foreignKey: options?.foreignKey,
      inverseSide: options?.inverseSide,
    });
  };
}

export function ManyToMany(
  target: () => Function,
  options?: { joinTable?: string; inverseSide?: string }
): PropertyDecorator {
  return (targetClass: object, propertyKey: string | symbol) => {
    const propertyName = String(propertyKey);
    metadataStorage.registerRelation(targetClass.constructor, propertyName, {
      propertyName,
      type: 'many-to-many',
      target,
      joinTable: options?.joinTable,
      inverseSide: options?.inverseSide,
    });
  };
}

function toSnakeCase(str: string): string {
  return str
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
}
