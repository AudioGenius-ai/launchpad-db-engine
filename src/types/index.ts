export type ColumnType =
  | 'uuid'
  | 'string'
  | 'text'
  | 'integer'
  | 'bigint'
  | 'float'
  | 'decimal'
  | 'boolean'
  | 'datetime'
  | 'date'
  | 'time'
  | 'json'
  | 'binary';

export interface ColumnDefinition {
  type: ColumnType;
  primaryKey?: boolean;
  nullable?: boolean;
  unique?: boolean;
  default?: string;
  references?: {
    table: string;
    column: string;
    onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
    onUpdate?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
  };
  tenant?: boolean;
}

export interface IndexDefinition {
  name?: string;
  columns: string[];
  unique?: boolean;
  where?: string;
}

export interface TableDefinition {
  columns: Record<string, ColumnDefinition>;
  indexes?: IndexDefinition[];
  primaryKey?: string[];
}

export interface SchemaDefinition {
  tables: Record<string, TableDefinition>;
}

export interface TenantContext {
  appId: string;
  organizationId: string;
  userId?: string;
}

export type Operator =
  | '='
  | '!='
  | '>'
  | '<'
  | '>='
  | '<='
  | 'LIKE'
  | 'ILIKE'
  | 'IN'
  | 'NOT IN'
  | 'IS NULL'
  | 'IS NOT NULL';

export interface WhereClause {
  column: string;
  op: Operator;
  value: unknown;
  connector?: 'AND' | 'OR';
}

export interface OrderByClause {
  column: string;
  direction: 'asc' | 'desc';
}

export interface GroupByClause {
  columns: string[];
}

export interface HavingClause {
  column: string;
  op: Operator;
  value: unknown;
}

export interface ConflictClause {
  columns: string[];
  action: 'update' | 'nothing';
  updateColumns?: string[];
}

export interface QueryAST {
  type: 'select' | 'insert' | 'update' | 'delete';
  table: string;
  columns?: string[];
  data?: Record<string, unknown>;
  dataRows?: Record<string, unknown>[];
  where?: WhereClause[];
  orderBy?: OrderByClause;
  groupBy?: GroupByClause;
  having?: HavingClause[];
  limit?: number;
  offset?: number;
  returning?: string[];
  joins?: JoinClause[];
  onConflict?: ConflictClause;
}

export interface JoinClause {
  type: 'INNER' | 'LEFT' | 'RIGHT' | 'FULL';
  table: string;
  alias?: string;
  on: {
    leftColumn: string;
    rightColumn: string;
  };
}

export interface CompiledQuery {
  sql: string;
  params: unknown[];
}

export interface MigrationFile {
  version: number;
  name: string;
  up: string[];
  down: string[];
  scope: 'core' | 'template';
  templateKey?: string;
  moduleName?: string;
}

export interface MigrationRecord {
  version: number;
  name: string;
  scope: 'core' | 'template';
  templateKey: string | null;
  moduleName: string | null;
  checksum: string;
  upSql: string[];
  downSql: string[];
  appliedAt: Date;
  executedBy: string | null;
}

export interface MigrationResult {
  version: number;
  name: string;
  success: boolean;
  error?: string;
  duration: number;
}

export interface MigrationStatus {
  applied: MigrationRecord[];
  pending: MigrationFile[];
  current: number | null;
}

export type DialectName = 'postgresql' | 'mysql' | 'sqlite' | 'mongodb';

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

export { generateTypes } from './generator.js';
export type { TypeGeneratorOptions } from './generator.js';
export { generateHooks } from './hooks-generator.js';
export type { HooksGeneratorOptions } from './hooks-generator.js';

export type MongoOperationType =
  | 'find'
  | 'aggregate'
  | 'insertOne'
  | 'insertMany'
  | 'updateOne'
  | 'updateMany'
  | 'deleteOne'
  | 'deleteMany'
  | 'findOneAndUpdate'
  | 'findOneAndDelete'
  | 'countDocuments';

export interface MongoOperationOptions {
  sort?: Record<string, 1 | -1>;
  limit?: number;
  skip?: number;
  projection?: Record<string, 0 | 1>;
  upsert?: boolean;
  returnDocument?: 'before' | 'after';
}

export interface MongoOperation {
  type: MongoOperationType;
  collection: string;
  filter?: Record<string, unknown>;
  pipeline?: Record<string, unknown>[];
  document?: Record<string, unknown>;
  documents?: Record<string, unknown>[];
  update?: Record<string, unknown>;
  options?: MongoOperationOptions;
}
