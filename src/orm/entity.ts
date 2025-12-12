import { metadataStorage } from './metadata.js';

export function applyTenantColumns(target: Function): void {
  metadataStorage.registerColumn(target, 'app_id', {
    propertyName: 'app_id',
    columnName: 'app_id',
    type: 'string',
    primaryKey: false,
    nullable: false,
    unique: false,
    tenant: true,
  });

  metadataStorage.registerColumn(target, 'organization_id', {
    propertyName: 'organization_id',
    columnName: 'organization_id',
    type: 'uuid',
    primaryKey: false,
    nullable: false,
    unique: false,
    tenant: true,
  });
}

export function applyTimestampColumns(target: Function): void {
  metadataStorage.registerColumn(target, 'created_at', {
    propertyName: 'created_at',
    columnName: 'created_at',
    type: 'datetime',
    primaryKey: false,
    nullable: false,
    unique: false,
    tenant: false,
    default: 'NOW()',
  });

  metadataStorage.registerColumn(target, 'updated_at', {
    propertyName: 'updated_at',
    columnName: 'updated_at',
    type: 'datetime',
    primaryKey: false,
    nullable: false,
    unique: false,
    tenant: false,
    default: 'NOW()',
  });
}

export function WithTenantColumns(): ClassDecorator {
  return (target: Function) => {
    applyTenantColumns(target);
  };
}

export function WithTimestamps(): ClassDecorator {
  return (target: Function) => {
    applyTimestampColumns(target);
  };
}

export abstract class TenantEntity {
  app_id!: string;
  organization_id!: string;
}

export abstract class TimestampedEntity {
  created_at!: Date;
  updated_at!: Date;
}

export abstract class TenantTimestampedEntity {
  app_id!: string;
  organization_id!: string;
  created_at!: Date;
  updated_at!: Date;
}
