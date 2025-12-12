export {
  Entity,
  Column,
  PrimaryKey,
  TenantColumn,
  Unique,
  Nullable,
  Default,
  Index,
  OneToMany,
  ManyToOne,
  OneToOne,
  ManyToMany,
} from './decorators.js';
export type { ColumnOptions, EntityOptions, IndexOptions } from './decorators.js';

export {
  TenantEntity,
  TimestampedEntity,
  TenantTimestampedEntity,
  WithTenantColumns,
  WithTimestamps,
  applyTenantColumns,
  applyTimestampColumns,
} from './entity.js';

export { metadataStorage } from './metadata.js';
export type {
  EntityMetadata,
  ColumnMetadata,
  RelationMetadata,
  EntityConstructor,
} from './metadata.js';

export {
  extractSchemaFromEntities,
  extractSchemaFromEntity,
  extractTableDefinition,
  getEntityTableName,
  getEntityColumns,
  propertyToColumn,
  columnToProperty,
} from './schema-extractor.js';
export type { ExtractSchemaOptions } from './schema-extractor.js';

export { Repository, createRepository } from './repository.js';
export type { WhereCondition, FindOptions, FindOneOptions } from './repository.js';
