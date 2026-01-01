import type { SchemaDefinition } from '../types/index.js';

export interface IntrospectedColumn {
  name: string;
  dataType: string;
  udtName: string;
  isNullable: boolean;
  defaultValue: string | null;
  maxLength: number | null;
  numericPrecision: number | null;
  numericScale: number | null;
  isIdentity: boolean;
  identityGeneration: 'ALWAYS' | 'BY DEFAULT' | null;
}

export interface IntrospectedIndex {
  name: string;
  columns: string[];
  isUnique: boolean;
  isPrimary: boolean;
  type: 'btree' | 'hash' | 'gin' | 'gist' | 'brin';
  expression: string | null;
}

export interface IntrospectedForeignKey {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
  onDelete: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
  onUpdate: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
}

export interface IntrospectedConstraint {
  name: string;
  type: 'CHECK' | 'UNIQUE' | 'PRIMARY KEY' | 'FOREIGN KEY' | 'EXCLUDE';
  definition: string;
}

export interface IntrospectedTable {
  name: string;
  schema: string;
  columns: IntrospectedColumn[];
  primaryKey: string[];
  foreignKeys: IntrospectedForeignKey[];
  indexes: IntrospectedIndex[];
  constraints: IntrospectedConstraint[];
}

export interface IntrospectedEnum {
  name: string;
  values: string[];
}

export interface SchemaIntrospectionResult {
  tables: IntrospectedTable[];
  enums: IntrospectedEnum[];
  extensions: string[];
  introspectedAt: Date;
  databaseVersion: string;
}

export interface IntrospectOptions {
  schemaPattern?: string;
  excludeTables?: string[];
  includeLaunchpadTables?: boolean;
}

export type ChangeType =
  | 'table_add'
  | 'table_drop'
  | 'column_add'
  | 'column_drop'
  | 'column_modify'
  | 'index_add'
  | 'index_drop'
  | 'constraint_add'
  | 'constraint_drop'
  | 'foreign_key_add'
  | 'foreign_key_drop';

export interface SchemaChange {
  type: ChangeType;
  tableName: string;
  objectName?: string;
  isBreaking: boolean;
  description: string;
  upSql: string;
  downSql: string;
  oldValue?: unknown;
  newValue?: unknown;
}

export interface DiffSummary {
  tablesAdded: number;
  tablesDropped: number;
  tablesModified: number;
  columnsAdded: number;
  columnsDropped: number;
  columnsModified: number;
  indexesAdded: number;
  indexesDropped: number;
  foreignKeysAdded: number;
  foreignKeysDropped: number;
}

export interface MigrationScript {
  version: string;
  name: string;
  upSql: string[];
  downSql: string[];
  checksum: string;
}

export interface SchemaSyncDiff {
  hasDifferences: boolean;
  summary: DiffSummary;
  changes: SchemaChange[];
  breakingChanges: SchemaChange[];
  migration: MigrationScript | null;
}

export interface SyncStatus {
  appId: string;
  tableName: string;
  localChecksum: string | null;
  localVersion: string | null;
  localUpdatedAt: Date | null;
  remoteChecksum: string | null;
  remoteVersion: string | null;
  remoteUpdatedAt: Date | null;
  syncStatus: 'synced' | 'pending' | 'behind' | 'conflict' | 'unknown';
  lastSyncAt: Date | null;
  lastSyncDirection: 'push' | 'pull' | null;
  lastSyncBy: string | null;
  baseChecksum: string | null;
  conflictDetails: Record<string, unknown> | null;
}

export interface PullOptions {
  environment?: string;
  dryRun?: boolean;
  force?: boolean;
}

export interface PushOptions {
  environment?: string;
  dryRun?: boolean;
  force?: boolean;
}

export interface DiffOptions {
  environment?: string;
  outputFormat?: 'text' | 'json' | 'sql';
}

export interface PullResult {
  applied: boolean;
  diff: SchemaSyncDiff;
}

export interface PushResult {
  applied: boolean;
  diff: SchemaSyncDiff;
  remoteResult?: RemotePushResult;
}

export interface RemoteSchemaResponse {
  schema: SchemaDefinition;
  version: string;
  checksum: string;
  updatedAt: string;
  environment: string;
}

export interface RemotePushResult {
  success: boolean;
  applied: boolean;
  migration?: MigrationScript;
  errors?: string[];
  warnings?: string[];
}

export interface RemoteSyncStatus {
  version: string;
  checksum: string;
  updatedAt: string;
  environment: string;
}

export class SchemaRemoteError extends Error {
  constructor(
    message: string,
    public statusCode?: number
  ) {
    super(message);
    this.name = 'SchemaRemoteError';
  }
}

export class BreakingChangeError extends Error {
  constructor(
    message: string,
    public changes: SchemaChange[] = []
  ) {
    super(message);
    this.name = 'BreakingChangeError';
  }
}

export class ConflictError extends Error {
  constructor(
    message: string,
    public conflicts: SchemaChange[] = []
  ) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class AuthenticationError extends Error {
  constructor(message = 'Authentication failed. Run `launchpad login` to authenticate.') {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export class UserCancelledError extends Error {
  constructor(message = 'Operation cancelled by user.') {
    super(message);
    this.name = 'UserCancelledError';
  }
}
