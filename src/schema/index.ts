export { SchemaRegistry, createSchemaRegistry } from './registry.js';
export type { SchemaRegistryOptions, RegisterSchemaOptions, SchemaRecord } from './registry.js';

export { SchemaIntrospector, createSchemaIntrospector } from './introspect.js';

export { SchemaDiffEngine, createSchemaDiffEngine } from './diff.js';
export type { SchemaDiffOptions } from './diff.js';

export { SchemaSyncService, createSchemaSyncService } from './sync.js';
export type { SchemaSyncServiceOptions, Logger } from './sync.js';

export { SyncMetadataManager, createSyncMetadataManager } from './sync-metadata.js';
export type { SyncMetadataOptions } from './sync-metadata.js';

export type {
  IntrospectedColumn,
  IntrospectedIndex,
  IntrospectedForeignKey,
  IntrospectedConstraint,
  IntrospectedTable,
  IntrospectedEnum,
  SchemaIntrospectionResult,
  IntrospectOptions,
  ChangeType,
  SchemaChange,
  DiffSummary,
  MigrationScript,
  SchemaSyncDiff,
  SyncStatus,
  PullOptions,
  PushOptions,
  DiffOptions,
  PullResult,
  PushResult,
  RemoteSchemaResponse,
  RemotePushResult,
  RemoteSyncStatus,
} from './types.js';

export {
  SchemaRemoteError,
  BreakingChangeError,
  ConflictError,
  AuthenticationError,
  UserCancelledError,
} from './types.js';
