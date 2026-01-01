export type BranchStatus = 'active' | 'protected' | 'stale' | 'deleting';

export interface Branch {
  id: string;
  name: string;
  slug: string;
  schemaName: string;
  parentBranchId: string | null;

  gitBranch: string | null;
  prNumber: number | null;
  prUrl: string | null;

  status: BranchStatus;
  isProtected: boolean;
  createdAt: Date;
  createdBy: string | null;
  lastAccessedAt: Date;
  deletedAt: Date | null;

  migrationCount: number;
  tableCount: number;
  storageBytes: number;

  autoDeleteDays: number;
  copyData: boolean;
  piiMasking: boolean;
}

export interface CreateBranchOptions {
  name: string;
  parentBranch?: string;
  gitBranch?: string;
  prNumber?: number;
  prUrl?: string;
  copyData?: boolean;
  piiMasking?: boolean;
  autoDeleteDays?: number;
  createdBy?: string;
}

export interface SwitchBranchResult {
  connectionString: string;
  searchPath: string;
  schemaName: string;
}

export interface TableDiff {
  name: string;
  action: 'added' | 'removed' | 'modified';
  sourceDefinition?: string;
  targetDefinition?: string;
}

export interface ColumnDiff {
  tableName: string;
  columnName: string;
  action: 'added' | 'removed' | 'modified';
  sourceType?: string;
  targetType?: string;
  sourceNullable?: boolean;
  targetNullable?: boolean;
  sourceDefault?: string;
  targetDefault?: string;
  isBreaking: boolean;
}

export interface IndexDiff {
  tableName: string;
  indexName: string;
  action: 'added' | 'removed' | 'modified';
  sourceDefinition?: string;
  targetDefinition?: string;
}

export interface ConstraintDiff {
  tableName: string;
  constraintName: string;
  constraintType: 'primary_key' | 'foreign_key' | 'unique' | 'check';
  action: 'added' | 'removed' | 'modified';
  isBreaking: boolean;
  sourceDefinition?: string;
  targetDefinition?: string;
}

export type ConflictResolution = 'keep_source' | 'keep_target' | 'manual';

export interface Conflict {
  type: 'column_type_mismatch' | 'constraint_conflict' | 'table_removed' | 'migration_order';
  description: string;
  sourcePath: string;
  targetPath: string;
  resolution: ConflictResolution[];
}

export interface SchemaDiff {
  source: string;
  target: string;
  generatedAt: Date;

  hasChanges: boolean;
  canAutoMerge: boolean;

  tables: TableDiff[];
  columns: ColumnDiff[];
  indexes: IndexDiff[];
  constraints: ConstraintDiff[];

  conflicts: Conflict[];

  forwardSql: string[];
  reverseSql: string[];
}

export interface MergeOptions {
  sourceBranch: string;
  targetBranch: string;
  dryRun?: boolean;
  conflictResolution?: Record<string, ConflictResolution>;
  deleteSourceAfterMerge?: boolean;
  author?: string;
}

export interface MergeResult {
  success: boolean;
  migrationsApplied: number;
  conflicts: Conflict[];
  errors: string[];
  rollbackAvailable: boolean;
}

export interface ListBranchesFilter {
  status?: BranchStatus;
  parentId?: string;
  staleDays?: number;
}

export interface CleanupOptions {
  maxAgeDays?: number;
  dryRun?: boolean;
  skipProtected?: boolean;
}

export interface CleanupResult {
  deleted: string[];
  skipped: string[];
}

export interface BranchRow {
  id: string;
  name: string;
  slug: string;
  schema_name: string;
  parent_branch_id: string | null;
  git_branch: string | null;
  pr_number: number | null;
  pr_url: string | null;
  status: BranchStatus;
  is_protected: boolean;
  created_at: Date | string;
  created_by: string | null;
  last_accessed_at: Date | string;
  deleted_at: Date | string | null;
  migration_count: number;
  table_count: number;
  storage_bytes: string | number;
  auto_delete_days: number;
  copy_data: boolean;
  pii_masking: boolean;
}

export interface SchemaTableInfo {
  table_name: string;
  table_type: string;
}

export interface SchemaColumnInfo {
  table_name: string;
  column_name: string;
  data_type: string;
  character_maximum_length: number | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
  is_nullable: string;
  column_default: string | null;
  udt_name: string;
  ordinal_position: number;
}

export interface SchemaIndexInfo {
  schemaname: string;
  tablename: string;
  indexname: string;
  indexdef: string;
}

export interface SchemaConstraintInfo {
  table_name: string;
  constraint_name: string;
  constraint_type: string;
  column_name: string | null;
  foreign_table_name: string | null;
  foreign_column_name: string | null;
}

export interface SchemaInfo {
  tables: SchemaTableInfo[];
  columns: SchemaColumnInfo[];
  indexes: SchemaIndexInfo[];
  constraints: SchemaConstraintInfo[];
}
