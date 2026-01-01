type ColumnType = 'uuid' | 'string' | 'text' | 'integer' | 'bigint' | 'float' | 'decimal' | 'boolean' | 'datetime' | 'date' | 'time' | 'json' | 'binary';
interface ColumnDefinition {
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
interface IndexDefinition {
    name?: string;
    columns: string[];
    unique?: boolean;
    where?: string;
}
interface TableDefinition {
    columns: Record<string, ColumnDefinition>;
    indexes?: IndexDefinition[];
    primaryKey?: string[];
}
interface SchemaDefinition {
    tables: Record<string, TableDefinition>;
}
interface TenantContext {
    appId: string;
    organizationId: string;
    userId?: string;
}
type Operator = '=' | '!=' | '>' | '<' | '>=' | '<=' | 'LIKE' | 'ILIKE' | 'IN' | 'NOT IN' | 'IS NULL' | 'IS NOT NULL';
interface WhereClause {
    column: string;
    op: Operator;
    value: unknown;
    connector?: 'AND' | 'OR';
}
interface OrderByClause {
    column: string;
    direction: 'asc' | 'desc';
}
interface GroupByClause {
    columns: string[];
}
interface HavingClause {
    column: string;
    op: Operator;
    value: unknown;
}
interface ConflictClause {
    columns: string[];
    action: 'update' | 'nothing';
    updateColumns?: string[];
}
interface QueryAST {
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
interface JoinClause {
    type: 'INNER' | 'LEFT' | 'RIGHT' | 'FULL';
    table: string;
    alias?: string;
    on: {
        leftColumn: string;
        rightColumn: string;
    };
}
interface CompiledQuery {
    sql: string;
    params: unknown[];
}
interface MigrationFile {
    version: number;
    name: string;
    up: string[];
    down: string[];
    scope: 'core' | 'template';
    templateKey?: string;
    moduleName?: string;
}
interface MigrationRecord$1 {
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
interface MigrationResult {
    version: number;
    name: string;
    success: boolean;
    error?: string;
    duration: number;
}
interface MigrationStatus {
    applied: MigrationRecord$1[];
    pending: MigrationFile[];
    current: number | null;
}
type DialectName = 'postgresql' | 'mysql' | 'sqlite' | 'mongodb';
interface QueryResult<T = Record<string, unknown>> {
    rows: T[];
    rowCount: number;
}
type MongoOperationType = 'find' | 'aggregate' | 'insertOne' | 'insertMany' | 'updateOne' | 'updateMany' | 'deleteOne' | 'deleteMany' | 'findOneAndUpdate' | 'findOneAndDelete' | 'countDocuments';
interface MongoOperationOptions {
    sort?: Record<string, 1 | -1>;
    limit?: number;
    skip?: number;
    projection?: Record<string, 0 | 1>;
    upsert?: boolean;
    returnDocument?: 'before' | 'after';
}
interface MongoOperation {
    type: MongoOperationType;
    collection: string;
    filter?: Record<string, unknown>;
    pipeline?: Record<string, unknown>[];
    document?: Record<string, unknown>;
    documents?: Record<string, unknown>[];
    update?: Record<string, unknown>;
    options?: MongoOperationOptions;
}

interface PoolStats {
    totalConnections: number;
    activeConnections: number;
    idleConnections: number;
    waitingRequests: number;
    maxConnections: number;
}
interface HealthCheckResult {
    healthy: boolean;
    latencyMs: number;
    lastCheckedAt: Date;
    error?: string;
}
interface HealthCheckConfig {
    enabled?: boolean;
    intervalMs?: number;
    timeoutMs?: number;
    onHealthChange?: (healthy: boolean, result: HealthCheckResult) => void;
}
declare function createHealthCheckResult(healthy: boolean, latencyMs: number, error?: string): HealthCheckResult;
declare function getDefaultHealthCheckConfig(overrides?: Partial<HealthCheckConfig>): HealthCheckConfig;

interface DriverConfig {
    connectionString: string;
    max?: number;
    idleTimeout?: number;
    connectTimeout?: number;
    healthCheck?: HealthCheckConfig;
}
type DrainPhase = 'draining' | 'cancelling' | 'closing' | 'complete';
interface DrainOptions {
    timeout?: number;
    onProgress?: (progress: DrainProgress) => void;
    forceCancelOnTimeout?: boolean;
}
interface DrainProgress {
    phase: DrainPhase;
    activeQueries: number;
    completedQueries: number;
    cancelledQueries: number;
    elapsedMs: number;
}
interface DrainResult {
    success: boolean;
    completedQueries: number;
    cancelledQueries: number;
    elapsedMs: number;
    error?: Error;
}
interface Driver {
    readonly dialect: DialectName;
    readonly connectionString: string;
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
    execute(sql: string, params?: unknown[]): Promise<{
        rowCount: number;
    }>;
    transaction<T>(fn: (trx: TransactionClient) => Promise<T>): Promise<T>;
    close(): Promise<void>;
    healthCheck(): Promise<HealthCheckResult>;
    getPoolStats(): PoolStats;
    isHealthy(): boolean;
    startHealthChecks(): void;
    stopHealthChecks(): void;
    drainAndClose(options?: DrainOptions): Promise<DrainResult>;
    getActiveQueryCount(): number;
    readonly isDraining: boolean;
}
interface TransactionClient {
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
    execute(sql: string, params?: unknown[]): Promise<{
        rowCount: number;
    }>;
}

interface SchemaRegistryOptions {
    tableName?: string;
}
interface RegisterSchemaOptions {
    appId: string;
    schemaName: string;
    version: string;
    schema: SchemaDefinition;
}
interface SchemaRecord {
    app_id: string;
    schema_name: string;
    version: string;
    schema: SchemaDefinition;
    checksum: string;
    created_at: Date;
    updated_at: Date;
}
declare class SchemaRegistry {
    private driver;
    private dialect;
    private tableName;
    constructor(driver: Driver, options?: SchemaRegistryOptions);
    ensureRegistryTable(): Promise<void>;
    register(options: RegisterSchemaOptions): Promise<MigrationResult[]>;
    getCurrentSchema(appId: string, schemaName: string): Promise<SchemaRecord | null>;
    listSchemas(appId?: string): Promise<SchemaRecord[]>;
    private validateSchema;
    private computeDiff;
    private columnsEqual;
    private upsertSchemaRecord;
    private computeChecksum;
}
declare function createSchemaRegistry(driver: Driver, options?: SchemaRegistryOptions): SchemaRegistry;

interface MongoCompilerOptions {
    injectTenant?: boolean;
    tenantColumns?: {
        appId: string;
        organizationId: string;
    };
}
declare class MongoCompiler {
    private injectTenant;
    private tenantColumns;
    constructor(options?: MongoCompilerOptions);
    compile(ast: QueryAST, ctx?: TenantContext): MongoOperation;
    private compileSelect;
    private compileSelectFind;
    private compileSelectAggregate;
    private compileInsert;
    private compileUpdate;
    private compileDelete;
    private buildFilter;
    private mapOperatorValue;
    private likeToRegex;
    private injectTenantData;
}

interface CompilerOptions {
    dialect: DialectName;
    injectTenant?: boolean;
    tenantColumns?: {
        appId: string;
        organizationId: string;
    };
}
declare class SQLCompiler {
    private dialect;
    private injectTenant;
    private tenantColumns;
    constructor(options: CompilerOptions);
    compile(ast: QueryAST, ctx?: TenantContext): CompiledQuery;
    private getParamPlaceholder;
    private compileSelect;
    private compileSelectFrom;
    private compileSelectJoins;
    private compileSelectWhere;
    private buildWherePredicates;
    private compileSelectGroupBy;
    private compileSelectHaving;
    private compileSelectOrderBy;
    private compileSelectLimitOffset;
    private compileInsert;
    private compileInsertMany;
    private compileOnConflict;
    private compileUpdate;
    private compileDelete;
    private compileReturning;
    private compileWhere;
    private joinPredicates;
    private compileHaving;
    private quoteIdentifier;
}
declare function createCompiler(options: CompilerOptions): SQLCompiler;

interface MigrationRunnerOptions {
    migrationsPath: string;
    tableName?: string;
}
interface MigrationRunOptions {
    scope?: 'core' | 'template';
    templateKey?: string;
    moduleName?: string;
    steps?: number;
    toVersion?: number;
    dryRun?: boolean;
}
declare class MigrationRunner {
    private driver;
    private dialect;
    private migrationsPath;
    private tableName;
    constructor(driver: Driver, options: MigrationRunnerOptions);
    ensureMigrationsTable(): Promise<void>;
    up(options?: MigrationRunOptions): Promise<MigrationResult[]>;
    down(options?: MigrationRunOptions): Promise<MigrationResult[]>;
    status(options?: MigrationRunOptions): Promise<MigrationStatus>;
    verify(options?: MigrationRunOptions): Promise<{
        valid: boolean;
        issues: string[];
    }>;
    private sanitizeTemplateKey;
    private loadMigrationFiles;
    private parseMigrationFile;
    private getAppliedMigrations;
    private getPendingMigrations;
    private recordMigration;
    private removeMigrationRecord;
    private computeChecksum;
    private splitSqlStatements;
}
declare function createMigrationRunner(driver: Driver, options: MigrationRunnerOptions): MigrationRunner;

interface MongoDriver extends Driver {
    executeOperation<T = Record<string, unknown>>(op: MongoOperation): Promise<QueryResult<T>>;
    getDb(): unknown;
    collection(name: string): unknown;
}
interface MongoTransactionClient extends TransactionClient {
    executeOperation<T = Record<string, unknown>>(op: MongoOperation): Promise<QueryResult<T>>;
}

declare class SelectBuilder<T = Record<string, unknown>> {
    private ast;
    private driver;
    private compiler;
    private ctx?;
    private tenantValidated;
    private shouldValidateTenant;
    constructor(driver: Driver | TransactionClient, compiler: SQLCompiler, table: string, ctx?: TenantContext, shouldValidateTenant?: boolean);
    private validateTenantOnce;
    select<K extends keyof T>(...columns: K[]): this;
    where(column: keyof T, op: Operator, value: unknown): this;
    whereNull(column: keyof T): this;
    whereNotNull(column: keyof T): this;
    whereIn(column: keyof T, values: unknown[]): this;
    whereNotIn(column: keyof T, values: unknown[]): this;
    whereLike(column: keyof T, pattern: string): this;
    whereILike(column: keyof T, pattern: string): this;
    orWhere(column: keyof T, op: Operator, value: unknown): this;
    groupBy(...columns: (keyof T)[]): this;
    having(column: keyof T, op: Operator, value: unknown): this;
    orderBy(column: keyof T, direction?: 'asc' | 'desc'): this;
    limit(n: number): this;
    offset(n: number): this;
    join(type: 'INNER' | 'LEFT' | 'RIGHT' | 'FULL', table: string, leftColumn: string, rightColumn: string, alias?: string): this;
    innerJoin(table: string, leftColumn: string, rightColumn: string, alias?: string): this;
    leftJoin(table: string, leftColumn: string, rightColumn: string, alias?: string): this;
    execute(): Promise<T[]>;
    first(): Promise<T | null>;
    count(): Promise<number>;
    toSQL(): {
        sql: string;
        params: unknown[];
    };
}
declare class InsertBuilder<T = Record<string, unknown>> {
    private ast;
    private driver;
    private compiler;
    private ctx?;
    private tenantValidated;
    private shouldValidateTenant;
    constructor(driver: Driver | TransactionClient, compiler: SQLCompiler, table: string, ctx?: TenantContext, shouldValidateTenant?: boolean);
    private validateTenantOnce;
    values(data: Partial<Omit<T, 'app_id' | 'organization_id'>>): this;
    valuesMany(rows: Partial<Omit<T, 'app_id' | 'organization_id'>>[]): this;
    onConflict(columns: (keyof T)[], action: 'update' | 'nothing', updateColumns?: (keyof T)[]): this;
    returning<K extends keyof T>(...columns: K[]): this;
    execute(): Promise<T[]>;
    toSQL(): {
        sql: string;
        params: unknown[];
    };
}
declare class UpdateBuilder<T = Record<string, unknown>> {
    private ast;
    private driver;
    private compiler;
    private ctx?;
    private tenantValidated;
    private shouldValidateTenant;
    constructor(driver: Driver | TransactionClient, compiler: SQLCompiler, table: string, ctx?: TenantContext, shouldValidateTenant?: boolean);
    private validateTenantOnce;
    set(data: Partial<Omit<T, 'app_id' | 'organization_id' | 'id' | 'created_at'>>): this;
    where(column: keyof T, op: Operator, value: unknown): this;
    returning<K extends keyof T>(...columns: K[]): this;
    execute(): Promise<T[]>;
    toSQL(): {
        sql: string;
        params: unknown[];
    };
}
declare class DeleteBuilder<T = Record<string, unknown>> {
    private ast;
    private driver;
    private compiler;
    private ctx?;
    private tenantValidated;
    private shouldValidateTenant;
    constructor(driver: Driver | TransactionClient, compiler: SQLCompiler, table: string, ctx?: TenantContext, shouldValidateTenant?: boolean);
    private validateTenantOnce;
    where(column: keyof T, op: Operator, value: unknown): this;
    returning<K extends keyof T>(...columns: K[]): this;
    execute(): Promise<T[]>;
    toSQL(): {
        sql: string;
        params: unknown[];
    };
}
declare class TableBuilder<T = Record<string, unknown>> {
    private driver;
    private compiler;
    private tableName;
    private ctx?;
    private shouldValidateTenant;
    private whereConditions;
    private orderByClause?;
    private limitValue?;
    private offsetValue?;
    constructor(driver: Driver | TransactionClient, compiler: SQLCompiler, table: string, ctx?: TenantContext, shouldValidateTenant?: boolean);
    where(column: keyof T, op: Operator, value: unknown): this;
    whereNull(column: keyof T): this;
    whereNotNull(column: keyof T): this;
    whereIn(column: keyof T, values: unknown[]): this;
    whereNotIn(column: keyof T, values: unknown[]): this;
    whereLike(column: keyof T, pattern: string): this;
    whereILike(column: keyof T, pattern: string): this;
    orderBy(column: keyof T, direction?: 'asc' | 'desc'): this;
    limit(n: number): this;
    offset(n: number): this;
    select<K extends keyof T>(...columns: K[]): SelectBuilder<T>;
    insert(): InsertBuilder<T>;
    update(data?: Partial<Omit<T, 'app_id' | 'organization_id' | 'id' | 'created_at'>>): UpdateBuilder<T>;
    delete(): DeleteBuilder<T>;
    findById(id: string | number): Promise<T | null>;
    findMany(options?: {
        where?: Array<{
            column: keyof T;
            op: Operator;
            value: unknown;
        }>;
        orderBy?: {
            column: keyof T;
            direction: 'asc' | 'desc';
        };
        limit?: number;
        offset?: number;
    }): Promise<T[]>;
}
declare class MongoSelectBuilder<T = Record<string, unknown>> {
    private ast;
    private driver;
    private compiler;
    private ctx?;
    private tenantValidated;
    private shouldValidateTenant;
    constructor(driver: MongoDriver | MongoTransactionClient, compiler: MongoCompiler, table: string, ctx?: TenantContext, shouldValidateTenant?: boolean);
    private validateTenantOnce;
    select<K extends keyof T>(...columns: K[]): this;
    where(column: keyof T, op: Operator, value: unknown): this;
    whereNull(column: keyof T): this;
    whereNotNull(column: keyof T): this;
    whereIn(column: keyof T, values: unknown[]): this;
    whereNotIn(column: keyof T, values: unknown[]): this;
    whereLike(column: keyof T, pattern: string): this;
    whereILike(column: keyof T, pattern: string): this;
    orWhere(column: keyof T, op: Operator, value: unknown): this;
    groupBy(...columns: (keyof T)[]): this;
    having(column: keyof T, op: Operator, value: unknown): this;
    orderBy(column: keyof T, direction?: 'asc' | 'desc'): this;
    limit(n: number): this;
    offset(n: number): this;
    join(type: 'INNER' | 'LEFT' | 'RIGHT' | 'FULL', table: string, leftColumn: string, rightColumn: string, alias?: string): this;
    innerJoin(table: string, leftColumn: string, rightColumn: string, alias?: string): this;
    leftJoin(table: string, leftColumn: string, rightColumn: string, alias?: string): this;
    execute(): Promise<T[]>;
    first(): Promise<T | null>;
    count(): Promise<number>;
    toOperation(): MongoOperation;
}
declare class MongoInsertBuilder<T = Record<string, unknown>> {
    private ast;
    private driver;
    private compiler;
    private ctx?;
    private tenantValidated;
    private shouldValidateTenant;
    constructor(driver: MongoDriver | MongoTransactionClient, compiler: MongoCompiler, table: string, ctx?: TenantContext, shouldValidateTenant?: boolean);
    private validateTenantOnce;
    values(data: Partial<Omit<T, 'app_id' | 'organization_id'>>): this;
    valuesMany(rows: Partial<Omit<T, 'app_id' | 'organization_id'>>[]): this;
    returning<K extends keyof T>(...columns: K[]): this;
    execute(): Promise<T[]>;
    toOperation(): MongoOperation;
}
declare class MongoUpdateBuilder<T = Record<string, unknown>> {
    private ast;
    private driver;
    private compiler;
    private ctx?;
    private tenantValidated;
    private shouldValidateTenant;
    constructor(driver: MongoDriver | MongoTransactionClient, compiler: MongoCompiler, table: string, ctx?: TenantContext, shouldValidateTenant?: boolean);
    private validateTenantOnce;
    set(data: Partial<Omit<T, 'app_id' | 'organization_id' | 'id' | 'created_at'>>): this;
    where(column: keyof T, op: Operator, value: unknown): this;
    returning<K extends keyof T>(...columns: K[]): this;
    execute(): Promise<T[]>;
    toOperation(): MongoOperation;
}
declare class MongoDeleteBuilder<T = Record<string, unknown>> {
    private ast;
    private driver;
    private compiler;
    private ctx?;
    private tenantValidated;
    private shouldValidateTenant;
    constructor(driver: MongoDriver | MongoTransactionClient, compiler: MongoCompiler, table: string, ctx?: TenantContext, shouldValidateTenant?: boolean);
    private validateTenantOnce;
    where(column: keyof T, op: Operator, value: unknown): this;
    returning<K extends keyof T>(...columns: K[]): this;
    execute(): Promise<T[]>;
    toOperation(): MongoOperation;
}
declare class MongoTableBuilder<T = Record<string, unknown>> {
    private driver;
    private compiler;
    private tableName;
    private ctx?;
    private shouldValidateTenant;
    private whereConditions;
    private orderByClause?;
    private limitValue?;
    private offsetValue?;
    constructor(driver: MongoDriver | MongoTransactionClient, compiler: MongoCompiler, table: string, ctx?: TenantContext, shouldValidateTenant?: boolean);
    where(column: keyof T, op: Operator, value: unknown): this;
    whereNull(column: keyof T): this;
    whereNotNull(column: keyof T): this;
    whereIn(column: keyof T, values: unknown[]): this;
    whereNotIn(column: keyof T, values: unknown[]): this;
    whereLike(column: keyof T, pattern: string): this;
    whereILike(column: keyof T, pattern: string): this;
    orderBy(column: keyof T, direction?: 'asc' | 'desc'): this;
    limit(n: number): this;
    offset(n: number): this;
    select<K extends keyof T>(...columns: K[]): MongoSelectBuilder<T>;
    insert(): MongoInsertBuilder<T>;
    update(data?: Partial<Omit<T, 'app_id' | 'organization_id' | 'id' | 'created_at'>>): MongoUpdateBuilder<T>;
    delete(): MongoDeleteBuilder<T>;
    findById(id: string | number): Promise<T | null>;
    findMany(options?: {
        where?: Array<{
            column: keyof T;
            op: Operator;
            value: unknown;
        }>;
        orderBy?: {
            column: keyof T;
            direction: 'asc' | 'desc';
        };
        limit?: number;
        offset?: number;
    }): Promise<T[]>;
}

interface DbClientOptions {
    migrationsPath?: string;
    tenantColumns?: {
        appId: string;
        organizationId: string;
    };
    strictTenantMode?: boolean;
}
declare class DbClient {
    private driver;
    private compiler;
    private migrationRunner?;
    private schemaRegistry;
    private strictTenantMode;
    constructor(driver: Driver, options?: DbClientOptions);
    table<T = Record<string, unknown>>(name: string, ctx: TenantContext): TableBuilder<T> | MongoTableBuilder<T>;
    tableWithoutTenant<T = Record<string, unknown>>(name: string): TableBuilder<T> | MongoTableBuilder<T>;
    transaction<T>(ctx: TenantContext, fn: (trx: TransactionContext) => Promise<T>): Promise<T>;
    raw<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
    rawWithTenant<T = Record<string, unknown>>(ctx: TenantContext, sql: string, params?: unknown[]): Promise<QueryResult<T>>;
    execute(sql: string, params?: unknown[]): Promise<{
        rowCount: number;
    }>;
    get migrations(): {
        up: (options?: MigrationRunOptions) => Promise<MigrationResult[]>;
        down: (options?: MigrationRunOptions) => Promise<MigrationResult[]>;
        status: (options?: MigrationRunOptions) => Promise<MigrationStatus>;
        verify: (options?: MigrationRunOptions) => Promise<{
            valid: boolean;
            issues: string[];
        }>;
    };
    get schema(): {
        register: (options: RegisterSchemaOptions) => Promise<MigrationResult[]>;
        get: (appId: string, schemaName: string) => Promise<SchemaRecord | null>;
        list: (appId?: string) => Promise<SchemaRecord[]>;
    };
    get dialect(): DialectName;
    close(): Promise<void>;
}
declare class TransactionContext {
    private client;
    private compiler;
    private ctx;
    constructor(client: TransactionClient, compiler: SQLCompiler | MongoCompiler, ctx: TenantContext);
    table<T = Record<string, unknown>>(name: string): TableBuilder<T>;
    raw<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
    execute(sql: string, params?: unknown[]): Promise<{
        rowCount: number;
    }>;
}
declare function createDbClient(driver: Driver, options?: DbClientOptions): DbClient;

interface ColumnOptions {
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
interface EntityOptions {
    name?: string;
}
interface IndexOptions {
    name?: string;
    columns: string[];
    unique?: boolean;
    where?: string;
}
declare function Entity(tableNameOrOptions?: string | EntityOptions): ClassDecorator;
declare function Column(type: ColumnType, options?: ColumnOptions): PropertyDecorator;
declare function PrimaryKey(): PropertyDecorator;
declare function TenantColumn(): PropertyDecorator;
declare function Unique(): PropertyDecorator;
declare function Nullable(): PropertyDecorator;
declare function Default(value: string): PropertyDecorator;
declare function Index(options: IndexOptions): ClassDecorator;
declare function OneToMany(target: () => Function, inverseSide: string): PropertyDecorator;
declare function ManyToOne(target: () => Function, options?: {
    foreignKey?: string;
}): PropertyDecorator;
declare function OneToOne(target: () => Function, options?: {
    foreignKey?: string;
    inverseSide?: string;
}): PropertyDecorator;
declare function ManyToMany(target: () => Function, options?: {
    joinTable?: string;
    inverseSide?: string;
}): PropertyDecorator;

declare function applyTenantColumns(target: Function): void;
declare function applyTimestampColumns(target: Function): void;
declare function WithTenantColumns(): ClassDecorator;
declare function WithTimestamps(): ClassDecorator;
declare abstract class TenantEntity {
    app_id: string;
    organization_id: string;
}
declare abstract class TimestampedEntity {
    created_at: Date;
    updated_at: Date;
}
declare abstract class TenantTimestampedEntity {
    app_id: string;
    organization_id: string;
    created_at: Date;
    updated_at: Date;
}

interface EntityMetadata {
    tableName: string;
    columns: Map<string, ColumnMetadata>;
    indexes: IndexDefinition[];
    relations: Map<string, RelationMetadata>;
}
interface ColumnMetadata {
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
interface RelationMetadata {
    propertyName: string;
    type: 'one-to-many' | 'many-to-one' | 'one-to-one' | 'many-to-many';
    target: () => Function;
    inverseSide?: string;
    foreignKey?: string;
    joinTable?: string;
}
type EntityConstructor<T = unknown> = new (...args: unknown[]) => T;
declare class MetadataStorage {
    private entities;
    registerEntity(target: Function, tableName: string): void;
    registerColumn(target: Function, propertyName: string, metadata: Partial<ColumnMetadata>): void;
    registerRelation(target: Function, propertyName: string, metadata: RelationMetadata): void;
    registerIndex(target: Function, index: IndexDefinition): void;
    getEntityMetadata(target: Function): EntityMetadata | undefined;
    getAllEntities(): Map<Function, EntityMetadata>;
    hasEntity(target: Function): boolean;
    private ensureEntity;
    private toSnakeCase;
    clear(): void;
}
declare const metadataStorage: MetadataStorage;

interface ExtractSchemaOptions {
    entities: EntityConstructor[];
}
declare function extractSchemaFromEntities(entities: EntityConstructor[]): SchemaDefinition;
declare function extractSchemaFromEntity(entity: EntityConstructor): SchemaDefinition;
declare function extractTableDefinition(metadata: EntityMetadata): TableDefinition;
declare function getEntityTableName(entity: EntityConstructor): string;
declare function getEntityColumns(entity: EntityConstructor): Map<string, string>;
declare function propertyToColumn(entity: EntityConstructor, propertyName: string): string;
declare function columnToProperty(entity: EntityConstructor, columnName: string): string;

type WhereCondition<T> = Partial<T> | [keyof T, Operator, unknown][];
interface FindOptions<T> {
    where?: WhereCondition<T>;
    orderBy?: {
        [K in keyof T]?: 'asc' | 'desc';
    };
    limit?: number;
    offset?: number;
    select?: (keyof T)[];
}
interface FindOneOptions<T> {
    where?: WhereCondition<T>;
    select?: (keyof T)[];
}
declare class Repository<T> {
    private db;
    private tenantContext?;
    private tableName;
    private columnMap;
    constructor(entity: EntityConstructor<T>, db: DbClient | TransactionContext, tenantContext?: TenantContext);
    find(options?: FindOptions<T>): Promise<T[]>;
    findOne(options?: FindOneOptions<T>): Promise<T | null>;
    findById(id: string | number): Promise<T | null>;
    create(data: Partial<T>): Promise<T>;
    createMany(data: Partial<T>[]): Promise<T[]>;
    update(where: WhereCondition<T>, data: Partial<T>): Promise<T[]>;
    updateById(id: string | number, data: Partial<T>): Promise<T | null>;
    delete(where: WhereCondition<T>): Promise<number>;
    deleteById(id: string | number): Promise<boolean>;
    count(where?: WhereCondition<T>): Promise<number>;
    exists(where: WhereCondition<T>): Promise<boolean>;
    private isDbClient;
    private createTableBuilder;
    private toColumn;
    private applyWhere;
    private applyWhereToUpdate;
    private applyWhereToDelete;
    private entityToRow;
    private rowToEntity;
}
declare function createRepository<T>(entity: EntityConstructor<T>, db: DbClient | TransactionContext, tenantContext?: TenantContext): Repository<T>;

interface QueryInfo {
    id: string;
    query: string;
    startedAt: Date;
    backendPid?: number;
}
declare class QueryTracker {
    private activeQueries;
    private completedCount;
    private cancelledCount;
    private draining;
    private drainResolve;
    trackQuery(id: string, query: string, backendPid?: number): void;
    untrackQuery(id: string): void;
    getActiveCount(): number;
    getActiveQueries(): QueryInfo[];
    startDrain(timeoutMs: number): Promise<{
        timedOut: boolean;
    }>;
    markCancelled(id: string): void;
    getStats(): {
        completed: number;
        cancelled: number;
        active: number;
    };
    isDraining(): boolean;
    reset(): void;
}

interface SignalHandlerOptions {
    timeout?: number;
    exitCodeSuccess?: number;
    exitCodeForced?: number;
    autoExit?: boolean;
    onShutdownStart?: () => void;
    onShutdownComplete?: (result: DrainResult) => void;
}
declare function registerSignalHandlers(driver: Driver, options?: SignalHandlerOptions): () => void;

interface PoolMonitorConfig {
    warningThreshold?: number;
    criticalThreshold?: number;
    checkIntervalMs?: number;
    onWarning?: (stats: PoolStats) => void;
    onCritical?: (stats: PoolStats) => void;
    onRecovery?: (stats: PoolStats) => void;
}
interface PoolMonitor {
    start(): void;
    stop(): void;
    getLastLevel(): 'normal' | 'warning' | 'critical';
}
declare function createPoolMonitor(getStats: () => PoolStats, config?: PoolMonitorConfig): PoolMonitor;

interface RetryConfig {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    retryableErrors?: string[];
}
declare function isRetryableError(error: unknown, customErrors?: string[]): boolean;
declare function withRetry<T>(operation: () => Promise<T>, config?: RetryConfig): Promise<T>;
declare function createTimeoutPromise<T>(timeoutMs: number): Promise<T>;

interface CreateDriverOptions extends DriverConfig {
    dialect?: DialectName;
    database?: string;
}
declare function detectDialect(connectionString: string): DialectName;
declare function createDriver(options: CreateDriverOptions): Promise<Driver>;

interface Dialect {
    name: 'postgresql' | 'mysql' | 'sqlite';
    mapType(type: ColumnType): string;
    createTable(name: string, def: TableDefinition): string;
    dropTable(name: string): string;
    addColumn(table: string, column: string, def: ColumnDefinition): string;
    dropColumn(table: string, column: string): string;
    alterColumn(table: string, column: string, def: ColumnDefinition): string;
    createIndex(table: string, index: IndexDefinition): string;
    dropIndex(name: string, table?: string): string;
    addForeignKey(table: string, column: string, refTable: string, refColumn: string, onDelete?: string): string;
    dropForeignKey(table: string, constraintName: string): string;
    supportsTransactionalDDL: boolean;
    introspectTablesQuery(): string;
    introspectColumnsQuery(table: string): string;
    introspectIndexesQuery(table: string): string;
}

declare const mysqlDialect: Dialect;

declare const postgresDialect: Dialect;

declare const sqliteDialect: Dialect;

declare function getDialect(name: DialectName): Dialect;

interface ModuleDefinition {
    name: string;
    displayName: string;
    description?: string;
    version: string;
    dependencies?: string[];
    migrationPrefix: string;
}
interface ModuleMigrationSource {
    moduleName: string;
    migrationsPath: string;
}

interface ModuleRegistryOptions {
    tableName?: string;
}
declare class ModuleRegistry {
    private driver;
    private dialect;
    private tableName;
    constructor(driver: Driver, options?: ModuleRegistryOptions);
    ensureTable(): Promise<void>;
    register(module: ModuleDefinition): Promise<void>;
    get(name: string): Promise<ModuleDefinition | null>;
    list(): Promise<ModuleDefinition[]>;
    unregister(name: string): Promise<void>;
}
declare function createModuleRegistry(driver: Driver, options?: ModuleRegistryOptions): ModuleRegistry;

interface MigrationCollectorOptions {
    scope?: 'core' | 'template';
}
declare class MigrationCollector {
    discoverFromDirectory(basePath: string): Promise<ModuleMigrationSource[]>;
    collect(sources: ModuleMigrationSource[], options?: MigrationCollectorOptions): Promise<MigrationFile[]>;
    private loadMigrationsFromSource;
    private parseMigrationFile;
    private orderMigrations;
    private splitSqlStatements;
}
declare function createMigrationCollector(): MigrationCollector;

interface IntrospectedColumn {
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
interface IntrospectedIndex {
    name: string;
    columns: string[];
    isUnique: boolean;
    isPrimary: boolean;
    type: 'btree' | 'hash' | 'gin' | 'gist' | 'brin';
    expression: string | null;
}
interface IntrospectedForeignKey {
    name: string;
    columns: string[];
    referencedTable: string;
    referencedColumns: string[];
    onDelete: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
    onUpdate: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
}
interface IntrospectedConstraint {
    name: string;
    type: 'CHECK' | 'UNIQUE' | 'PRIMARY KEY' | 'FOREIGN KEY' | 'EXCLUDE';
    definition: string;
}
interface IntrospectedTable {
    name: string;
    schema: string;
    columns: IntrospectedColumn[];
    primaryKey: string[];
    foreignKeys: IntrospectedForeignKey[];
    indexes: IntrospectedIndex[];
    constraints: IntrospectedConstraint[];
}
interface IntrospectedEnum {
    name: string;
    values: string[];
}
interface SchemaIntrospectionResult {
    tables: IntrospectedTable[];
    enums: IntrospectedEnum[];
    extensions: string[];
    introspectedAt: Date;
    databaseVersion: string;
}
interface IntrospectOptions {
    schemaPattern?: string;
    excludeTables?: string[];
    includeLaunchpadTables?: boolean;
}
type ChangeType = 'table_add' | 'table_drop' | 'column_add' | 'column_drop' | 'column_modify' | 'index_add' | 'index_drop' | 'constraint_add' | 'constraint_drop' | 'foreign_key_add' | 'foreign_key_drop';
interface SchemaChange {
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
interface DiffSummary {
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
interface MigrationScript {
    version: string;
    name: string;
    upSql: string[];
    downSql: string[];
    checksum: string;
}
interface SchemaSyncDiff {
    hasDifferences: boolean;
    summary: DiffSummary;
    changes: SchemaChange[];
    breakingChanges: SchemaChange[];
    migration: MigrationScript | null;
}
interface SyncStatus {
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
interface PullOptions {
    environment?: string;
    dryRun?: boolean;
    force?: boolean;
}
interface PushOptions {
    environment?: string;
    dryRun?: boolean;
    force?: boolean;
}
interface DiffOptions {
    environment?: string;
    outputFormat?: 'text' | 'json' | 'sql';
}
interface PullResult {
    applied: boolean;
    diff: SchemaSyncDiff;
}
interface PushResult {
    applied: boolean;
    diff: SchemaSyncDiff;
    remoteResult?: RemotePushResult$1;
}
interface RemoteSchemaResponse$1 {
    schema: SchemaDefinition;
    version: string;
    checksum: string;
    updatedAt: string;
    environment: string;
}
interface RemotePushResult$1 {
    success: boolean;
    applied: boolean;
    migration?: MigrationScript;
    errors?: string[];
    warnings?: string[];
}
interface RemoteSyncStatus$1 {
    version: string;
    checksum: string;
    updatedAt: string;
    environment: string;
}
declare class SchemaRemoteError extends Error {
    statusCode?: number | undefined;
    constructor(message: string, statusCode?: number | undefined);
}
declare class BreakingChangeError extends Error {
    changes: SchemaChange[];
    constructor(message: string, changes?: SchemaChange[]);
}
declare class ConflictError extends Error {
    conflicts: SchemaChange[];
    constructor(message: string, conflicts?: SchemaChange[]);
}
declare class AuthenticationError extends Error {
    constructor(message?: string);
}
declare class UserCancelledError extends Error {
    constructor(message?: string);
}

declare class SchemaIntrospector {
    private driver;
    private dialect;
    constructor(driver: Driver, dialect: Dialect);
    introspect(options?: IntrospectOptions): Promise<SchemaIntrospectionResult>;
    introspectTables(options?: IntrospectOptions): Promise<IntrospectedTable[]>;
    listTables(options?: IntrospectOptions): Promise<string[]>;
    introspectTable(tableName: string): Promise<IntrospectedTable>;
    introspectColumns(tableName: string): Promise<IntrospectedColumn[]>;
    private introspectPostgresColumns;
    private introspectMysqlColumns;
    private introspectSqliteColumns;
    introspectIndexes(tableName: string): Promise<IntrospectedIndex[]>;
    private introspectPostgresIndexes;
    private introspectMysqlIndexes;
    private introspectSqliteIndexes;
    introspectForeignKeys(tableName: string): Promise<IntrospectedForeignKey[]>;
    private introspectPostgresForeignKeys;
    private introspectMysqlForeignKeys;
    private introspectSqliteForeignKeys;
    introspectConstraints(tableName: string): Promise<IntrospectedConstraint[]>;
    introspectEnums(): Promise<IntrospectedEnum[]>;
    introspectExtensions(): Promise<string[]>;
    getDatabaseVersion(): Promise<string>;
    private extractPrimaryKey;
    toSchemaDefinition(result: SchemaIntrospectionResult): SchemaDefinition;
    private tableToDefinition;
    private columnToDefinition;
    private mapDataTypeToColumnType;
}
declare function createSchemaIntrospector(driver: Driver, dialect: Dialect): SchemaIntrospector;

interface SchemaDiffOptions {
    generateMigration?: boolean;
    treatColumnDropAsBreaking?: boolean;
    treatTableDropAsBreaking?: boolean;
    migrationName?: string;
}
declare class SchemaDiffEngine {
    private dialect;
    constructor(dialect: Dialect);
    computeDiff(current: SchemaDefinition | null, target: SchemaDefinition, options?: SchemaDiffOptions): SchemaSyncDiff;
    private generateTableAddChanges;
    private generateTableDropChange;
    private compareColumns;
    private compareIndexes;
    private generateColumnAlteration;
    private isColumnChangeBreaking;
    private columnsEqual;
    private summarizeChanges;
    private generateMigration;
    formatDiff(diff: SchemaSyncDiff, format?: 'text' | 'json' | 'sql'): string;
}
declare function createSchemaDiffEngine(dialect: Dialect): SchemaDiffEngine;

interface RemoteConfig {
    apiUrl: string;
    projectId: string;
    authToken: string;
}
interface RemoteSchemaResponse {
    schema: SchemaDefinition;
    version: string;
    checksum: string;
    updatedAt: string;
    environment: string;
}
interface RemotePushOptions {
    environment?: string;
    dryRun?: boolean;
    force?: boolean;
}
interface RemotePushResult {
    success: boolean;
    applied: boolean;
    migration?: MigrationScript;
    errors?: string[];
    warnings?: string[];
}
interface RemoteSyncStatus {
    version: string;
    checksum: string;
    updatedAt: string;
    environment: string;
}
interface RemoteHealthResponse {
    status: 'healthy' | 'degraded' | 'unhealthy';
    version: string;
}
interface RemoteApiError {
    code: string;
    message: string;
    details?: Record<string, unknown>;
}

interface SchemaRemoteClientOptions {
    timeout?: number;
    retries?: number;
}
declare class SchemaRemoteClient {
    private apiUrl;
    private projectId;
    private authToken;
    private timeout;
    private retries;
    private schemaCache;
    private readonly CACHE_TTL;
    constructor(config: RemoteConfig, options?: SchemaRemoteClientOptions);
    fetchSchema(environment?: string): Promise<RemoteSchemaResponse>;
    pushMigration(migration: MigrationScript, options?: RemotePushOptions): Promise<RemotePushResult>;
    getSyncStatus(environment?: string): Promise<RemoteSyncStatus>;
    healthCheck(): Promise<RemoteHealthResponse>;
    clearCache(): void;
    private request;
    private delay;
}
declare function createSchemaRemoteClient(config: RemoteConfig, options?: SchemaRemoteClientOptions): SchemaRemoteClient;

interface SchemaSyncServiceOptions {
    appId: string;
    migrationsPath?: string;
}
interface Logger {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}
declare class SchemaSyncService {
    private driver;
    private dialect;
    private remoteClient;
    private options;
    private logger;
    private introspector;
    private diffEngine;
    private syncMetadata;
    constructor(driver: Driver, dialect: Dialect, remoteClient: SchemaRemoteClient, options: SchemaSyncServiceOptions, logger?: Logger);
    pull(options?: PullOptions): Promise<PullResult>;
    push(options?: PushOptions): Promise<PushResult>;
    diff(options?: DiffOptions): Promise<SchemaSyncDiff>;
    getSyncStatus(): Promise<SyncStatus | null>;
    introspectLocal(): Promise<SchemaDefinition>;
    formatDiff(diff: SchemaSyncDiff, format?: 'text' | 'json' | 'sql'): string;
    private applyMigration;
    private computeSchemaChecksum;
}
declare function createSchemaSyncService(driver: Driver, dialect: Dialect, remoteClient: SchemaRemoteClient, options: SchemaSyncServiceOptions, logger?: Logger): SchemaSyncService;

interface SyncMetadataOptions {
    tableName?: string;
}
declare class SyncMetadataManager {
    private driver;
    private dialect;
    private tableName;
    constructor(driver: Driver, dialect: Dialect, options?: SyncMetadataOptions);
    ensureSyncTable(): Promise<void>;
    getSyncState(appId: string, tableName: string): Promise<SyncStatus | null>;
    getAllSyncStates(appId: string): Promise<SyncStatus[]>;
    updateSyncState(appId: string, direction: 'push' | 'pull', data: {
        localChecksum?: string;
        localVersion?: string;
        remoteChecksum?: string;
        remoteVersion?: string;
        syncBy?: string;
    }): Promise<void>;
    markConflict(appId: string, tableName: string, conflictDetails: Record<string, unknown>): Promise<void>;
    detectConflicts(appId: string): Promise<SyncStatus[]>;
    private generateUUID;
}
declare function createSyncMetadataManager(driver: Driver, dialect: Dialect, options?: SyncMetadataOptions): SyncMetadataManager;

interface Credentials {
    token: string;
    refreshToken?: string;
    expiresAt?: string;
    projectId?: string;
}
interface AuthConfig {
    credentialsPath?: string;
}
declare class AuthHandler {
    private credentialsPath;
    private cachedCredentials;
    constructor(config?: AuthConfig);
    getToken(): Promise<string>;
    getProjectId(): Promise<string | undefined>;
    saveCredentials(credentials: Credentials): Promise<void>;
    clearCredentials(): Promise<void>;
    isAuthenticated(): Promise<boolean>;
    private loadCredentials;
    private refreshToken;
}
declare function createAuthHandler(config?: AuthConfig): AuthHandler;

interface TypeGeneratorOptions {
    includeInsertTypes?: boolean;
    includeUpdateTypes?: boolean;
    omitTenantColumns?: boolean;
}
declare function generateTypes(schemas: Map<string, SchemaDefinition>, options?: TypeGeneratorOptions): string;
declare function generateSchemaFromDefinition(schema: SchemaDefinition): string;

declare class TenantContextError extends Error {
    constructor(message: string);
}
declare function validateTenantContext(ctx: TenantContext | undefined, tableName: string): void;
declare function validateTenantContextOrWarn(ctx: TenantContext | undefined, tableName: string): void;

interface SeedResult {
    count: number;
    details?: Record<string, number>;
}
interface SeederMetadata {
    name: string;
    order: number;
    dependencies: string[];
    version: number;
}
interface SeederLogger {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}
declare abstract class Seeder {
    static order: number;
    static dependencies: string[];
    static version: number;
    protected driver: Driver;
    protected logger: SeederLogger;
    constructor(driver: Driver, logger?: SeederLogger);
    abstract run(): Promise<SeedResult>;
    rollback(): Promise<void>;
    get metadata(): SeederMetadata;
    protected query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
    protected execute(sql: string, params?: unknown[]): Promise<{
        rowCount: number;
    }>;
    protected transaction<T>(fn: (trx: TransactionClient) => Promise<T>): Promise<T>;
}

type SeederConstructor = new (driver: Driver, logger?: SeederLogger) => Seeder;
interface LoadedSeeder {
    name: string;
    path: string;
    type: 'typescript' | 'sql';
    order: number;
    dependencies: string[];
    SeederClass?: SeederConstructor & {
        order?: number;
        dependencies?: string[];
        version?: number;
    };
    sqlContent?: string;
}
interface SeedLoaderOptions {
    seedsPath?: string;
}
declare class SeedLoader {
    private seedsPath;
    constructor(options?: SeedLoaderOptions);
    discover(): Promise<LoadedSeeder[]>;
    private findSeedFiles;
    private loadTypeScriptSeeder;
    private loadSqlSeeder;
    private extractName;
    private extractOrderFromFilename;
    private sortByDependencies;
    private topologicalSort;
    createInstance(loaded: LoadedSeeder, driver: Driver, logger?: SeederLogger): Seeder;
}

interface SeedRunnerOptions {
    seedsPath?: string;
    tableName?: string;
}
interface SeedRunOptions {
    only?: string;
    fresh?: boolean;
    dryRun?: boolean;
    force?: boolean;
    allowProduction?: boolean;
}
interface SeederResult {
    name: string;
    status: 'success' | 'skipped' | 'failed';
    count: number;
    duration: number;
    error?: string;
}
interface SeedRunResult {
    success: boolean;
    seeders: SeederResult[];
    totalCount: number;
    totalDuration: number;
}
declare class SeedRunner {
    private driver;
    private dialect;
    private loader;
    private tracker;
    private logger;
    constructor(driver: Driver, options?: SeedRunnerOptions);
    run(options?: SeedRunOptions): Promise<SeedRunResult>;
    rollback(seederName?: string): Promise<void>;
    status(): Promise<SeedRunResult>;
    private filterSeeders;
    private resolveDependencies;
    private executeSeeder;
    private runWithTransaction;
    private dryRunSeeder;
    private truncateTables;
}
declare function createSeedRunner(driver: Driver, options?: SeedRunnerOptions): SeedRunner;

interface SeedTrackerOptions {
    tableName?: string;
}
interface SeedRecord {
    id: number;
    name: string;
    version: number;
    executed_at: Date;
    execution_time_ms: number;
    record_count: number;
    checksum?: string;
}
declare class SeedTracker {
    private driver;
    private dialect;
    private tableName;
    constructor(driver: Driver, options?: SeedTrackerOptions);
    ensureTable(): Promise<void>;
    hasRun(name: string, version: number): Promise<boolean>;
    record(name: string, version: number, result: SeedResult, duration: number): Promise<void>;
    remove(name: string): Promise<void>;
    clear(): Promise<void>;
    list(): Promise<SeedRecord[]>;
}

declare class SqlSeederAdapter extends Seeder {
    private sqlContent;
    private seederName;
    constructor(driver: Driver, sqlContent: string, name: string, logger?: SeederLogger);
    get name(): string;
    run(): Promise<SeedResult>;
    private splitStatements;
}

type BranchStatus = 'active' | 'protected' | 'stale' | 'deleting';
interface Branch {
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
interface CreateBranchOptions {
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
interface SwitchBranchResult {
    connectionString: string;
    searchPath: string;
    schemaName: string;
}
interface TableDiff {
    name: string;
    action: 'added' | 'removed' | 'modified';
    sourceDefinition?: string;
    targetDefinition?: string;
}
interface ColumnDiff {
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
interface IndexDiff {
    tableName: string;
    indexName: string;
    action: 'added' | 'removed' | 'modified';
    sourceDefinition?: string;
    targetDefinition?: string;
}
interface ConstraintDiff {
    tableName: string;
    constraintName: string;
    constraintType: 'primary_key' | 'foreign_key' | 'unique' | 'check';
    action: 'added' | 'removed' | 'modified';
    isBreaking: boolean;
    sourceDefinition?: string;
    targetDefinition?: string;
}
type ConflictResolution = 'keep_source' | 'keep_target' | 'manual';
interface Conflict {
    type: 'column_type_mismatch' | 'constraint_conflict' | 'table_removed' | 'migration_order';
    description: string;
    sourcePath: string;
    targetPath: string;
    resolution: ConflictResolution[];
}
interface SchemaDiff {
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
interface MergeOptions {
    sourceBranch: string;
    targetBranch: string;
    dryRun?: boolean;
    conflictResolution?: Record<string, ConflictResolution>;
    deleteSourceAfterMerge?: boolean;
    author?: string;
}
interface MergeResult {
    success: boolean;
    migrationsApplied: number;
    conflicts: Conflict[];
    errors: string[];
    rollbackAvailable: boolean;
}
interface ListBranchesFilter {
    status?: BranchStatus;
    parentId?: string;
    staleDays?: number;
}
interface CleanupOptions {
    maxAgeDays?: number;
    dryRun?: boolean;
    skipProtected?: boolean;
}
interface CleanupResult {
    deleted: string[];
    skipped: string[];
}

interface BranchManagerOptions {
    driver: Driver;
    mainSchemaName?: string;
    branchPrefix?: string;
    defaultAutoDeleteDays?: number;
    metadataTableName?: string;
}
declare class BranchManager {
    private driver;
    private mainSchema;
    private branchPrefix;
    private defaultAutoDeleteDays;
    private metadataTable;
    constructor(options: BranchManagerOptions);
    ensureMetadataTable(): Promise<void>;
    createBranch(options: CreateBranchOptions): Promise<Branch>;
    getBranchBySlug(slug: string): Promise<Branch | null>;
    getBranchById(id: string): Promise<Branch | null>;
    deleteBranch(branchSlug: string, force?: boolean): Promise<void>;
    switchBranch(branchSlug: string): Promise<SwitchBranchResult>;
    diffBranches(sourceBranch: string, targetBranch: string): Promise<SchemaDiff>;
    mergeBranch(options: MergeOptions): Promise<MergeResult>;
    listBranches(filter?: ListBranchesFilter): Promise<Branch[]>;
    cleanupStaleBranches(options?: CleanupOptions): Promise<CleanupResult>;
    protectBranch(branchSlug: string): Promise<void>;
    unprotectBranch(branchSlug: string): Promise<void>;
    updateBranchStats(branchSlug: string): Promise<void>;
    private cloneSchemaStructure;
    private cloneSequences;
    private cloneViews;
    private copyDataWithMasking;
    private isPiiColumn;
    private getTableCount;
    private generateSlug;
    private quoteIdent;
    private resolveSchemaName;
    private generateConnectionString;
    private mapBranchRow;
}
declare function createBranchManager(options: BranchManagerOptions): BranchManager;

declare class SchemaDiffer {
    private driver;
    constructor(driver: Driver);
    diff(sourceSchema: string, targetSchema: string): Promise<SchemaDiff>;
    private getSchemaInfo;
    private diffTables;
    private diffColumns;
    private findAddedColumns;
    private findRemovedColumns;
    private findModifiedColumns;
    private diffIndexes;
    private diffConstraints;
    private detectConflicts;
    private generateMigrationSql;
    private generateTableSql;
    private shouldCreate;
    private shouldDrop;
    private generateColumnSql;
    private generateSingleColumnSql;
    private generateIndexSql;
    private generateSingleIndexSql;
    private generateConstraintSql;
    private generateSingleConstraintSql;
    private getTableDefinition;
    private getColumnType;
    private hasColumnChanges;
    private normalizeDefault;
    private isBreakingTypeChange;
    private isAutoGeneratedConstraint;
    private normalizeIndexDef;
    private mapConstraintType;
    private getConstraintDefinition;
}

interface MigrationRecord {
    version: number;
    name: string;
    scope: 'core' | 'template';
    checksum: string;
    upSql: string[];
    downSql: string[];
    appliedAt: Date;
}
interface MigrationMergerOptions {
    mainSchema?: string;
    branchPrefix?: string;
    migrationsTable?: string;
}
declare class MigrationMerger {
    private driver;
    private mainSchema;
    private migrationsTable;
    constructor(driver: Driver, options?: MigrationMergerOptions);
    merge(options: MergeOptions): Promise<MergeResult>;
    getPendingMigrations(_sourceBranch: string, _targetBranch: string): Promise<MigrationRecord[]>;
    detectMigrationConflicts(migrations: MigrationRecord[], targetBranch: string): Promise<Conflict[]>;
    private allConflictsResolved;
    private resolveSchemaName;
    private tableExists;
    private computeChecksum;
    private quoteIdent;
}

interface ConnectionManagerOptions {
    driver: Driver;
    mainSchema?: string;
    branchPrefix?: string;
}
interface BranchConnection {
    schemaName: string;
    searchPath: string;
    connectionString: string;
}
declare class ConnectionManager {
    private driver;
    private mainSchema;
    private branchPrefix;
    private currentSchema;
    constructor(options: ConnectionManagerOptions);
    switchToBranch(branchSlug: string): Promise<BranchConnection>;
    switchToMain(): Promise<BranchConnection>;
    withBranch<T>(branchSlug: string, callback: (client: TransactionClient) => Promise<T>): Promise<T>;
    withSchema<T>(schemaName: string, callback: (client: TransactionClient) => Promise<T>): Promise<T>;
    getCurrentSchema(): string;
    getCurrentSearchPath(): Promise<string>;
    validateSchema(schemaName: string): Promise<boolean>;
    listAvailableSchemas(): Promise<string[]>;
    generateConnectionString(schemaName: string): string;
    generateEnvVars(schemaName: string): Record<string, string>;
    private getSchemaForBranch;
    private updateLastAccessed;
}
declare function createConnectionManager(options: ConnectionManagerOptions): ConnectionManager;

interface CleanupSchedulerOptions {
    driver: Driver;
    intervalMs?: number;
    defaultMaxAgeDays?: number;
    skipProtected?: boolean;
    metadataTable?: string;
    onCleanup?: (result: CleanupResult) => void;
    onError?: (error: Error) => void;
}
interface CleanupJob {
    id: string;
    startedAt: Date;
    completedAt?: Date;
    result?: CleanupResult;
    error?: string;
}
declare class CleanupScheduler {
    private driver;
    private intervalMs;
    private defaultMaxAgeDays;
    private skipProtected;
    private metadataTable;
    private onCleanup?;
    private onError?;
    private intervalId;
    private isRunning;
    private lastRun;
    private history;
    constructor(options: CleanupSchedulerOptions);
    start(): void;
    stop(): void;
    isScheduled(): boolean;
    isCurrentlyRunning(): boolean;
    getLastRun(): CleanupJob | null;
    getHistory(limit?: number): CleanupJob[];
    runCleanup(options?: {
        maxAgeDays?: number;
        dryRun?: boolean;
    }): Promise<CleanupResult>;
    private executeCleanup;
    private tryDeleteBranch;
    private recordSuccess;
    private recordError;
    getStaleBranches(maxAgeDays: number): Promise<Branch[]>;
    markAsStale(maxAgeDays: number): Promise<number>;
    getUpcomingCleanups(daysAhead?: number): Promise<{
        branch: Branch;
        daysUntilCleanup: number;
    }[]>;
    private deleteBranch;
    private generateJobId;
    private quoteIdent;
    private mapBranchRow;
}
declare function createCleanupScheduler(options: CleanupSchedulerOptions): CleanupScheduler;

declare function createDb(options: {
    connectionString: string;
    migrationsPath?: string;
    tenantColumns?: {
        appId: string;
        organizationId: string;
    };
    strictTenantMode?: boolean;
}): Promise<DbClient>;

export { type AuthConfig, AuthHandler, AuthenticationError, type Branch, type BranchConnection, BranchManager, type BranchManagerOptions, type BranchStatus, BreakingChangeError, type ChangeType, type CleanupJob, type CleanupOptions, type CleanupResult, CleanupScheduler, type CleanupSchedulerOptions, Column, type ColumnDefinition, type ColumnDiff, type ColumnMetadata, type ColumnOptions, type ColumnType, type CompiledQuery, type CompilerOptions, type Conflict, type ConflictClause, ConflictError, type ConflictResolution, ConnectionManager, type ConnectionManagerOptions, type ConstraintDiff, type CreateBranchOptions, type CreateDriverOptions, type Credentials, DbClient, type DbClientOptions, Default, DeleteBuilder, type Dialect, type DialectName, type DiffOptions, type DiffSummary, type DrainOptions, type DrainPhase, type DrainProgress, type DrainResult, type Driver, type DriverConfig, Entity, type EntityConstructor, type EntityMetadata, type EntityOptions, type ExtractSchemaOptions, type FindOneOptions, type FindOptions, type GroupByClause, type HavingClause, type HealthCheckConfig, type HealthCheckResult, Index, type IndexDefinition, type IndexDiff, type IndexOptions, InsertBuilder, type IntrospectOptions, type IntrospectedColumn, type IntrospectedConstraint, type IntrospectedEnum, type IntrospectedForeignKey, type IntrospectedIndex, type IntrospectedTable, type JoinClause, type ListBranchesFilter, type LoadedSeeder, type Logger, ManyToMany, ManyToOne, type MergeOptions, type MergeResult, MigrationCollector, type MigrationCollectorOptions, type MigrationFile, MigrationMerger, type MigrationMergerOptions, type MigrationRecord, type MigrationResult, type MigrationRunOptions, MigrationRunner, type MigrationRunnerOptions, type MigrationScript, type MigrationStatus, type ModuleDefinition, type ModuleMigrationSource, ModuleRegistry, type ModuleRegistryOptions, type MongoOperation, type MongoOperationOptions, type MongoOperationType, Nullable, OneToMany, OneToOne, type Operator, type OrderByClause, type PoolMonitor, type PoolMonitorConfig, type PoolStats, PrimaryKey, type PullOptions, type PullResult, type PushOptions, type PushResult, type QueryAST, type QueryInfo, type QueryResult, QueryTracker, type RegisterSchemaOptions, type RelationMetadata, type RemoteApiError, type RemoteConfig, type RemoteHealthResponse, type RemotePushOptions, type RemotePushResult$1 as RemotePushResult, type RemoteSchemaResponse$1 as RemoteSchemaResponse, type RemoteSyncStatus$1 as RemoteSyncStatus, Repository, type RetryConfig, SQLCompiler, type SchemaChange, type SchemaDefinition, type SchemaDiff, SchemaDiffEngine, type SchemaDiffOptions, SchemaDiffer, type SchemaIntrospectionResult, SchemaIntrospector, SchemaRegistry, type SchemaRegistryOptions, SchemaRemoteClient, type SchemaRemoteClientOptions, SchemaRemoteError, type SchemaSyncDiff, SchemaSyncService, type SchemaSyncServiceOptions, SeedLoader, type SeedLoaderOptions, type SeedRecord, type SeedResult, type SeedRunOptions, type SeedRunResult, SeedRunner, type SeedRunnerOptions, SeedTracker, type SeedTrackerOptions, Seeder, type SeederConstructor, type SeederLogger, type SeederMetadata, type SeederResult, SelectBuilder, type SignalHandlerOptions, SqlSeederAdapter, type SwitchBranchResult, SyncMetadataManager, type SyncMetadataOptions, type SyncStatus, TableBuilder, type TableDefinition, type TableDiff, TenantColumn, type TenantContext, TenantContextError, TenantEntity, TenantTimestampedEntity, TimestampedEntity, type TransactionClient, TransactionContext, type TypeGeneratorOptions, Unique, UpdateBuilder, UserCancelledError, type WhereClause, type WhereCondition, WithTenantColumns, WithTimestamps, applyTenantColumns, applyTimestampColumns, columnToProperty, createAuthHandler, createBranchManager, createCleanupScheduler, createCompiler, createConnectionManager, createDb, createDbClient, createDriver, createHealthCheckResult, createMigrationCollector, createMigrationRunner, createModuleRegistry, createPoolMonitor, createRepository, createSchemaDiffEngine, createSchemaIntrospector, createSchemaRegistry, createSchemaRemoteClient, createSchemaSyncService, createSeedRunner, createSyncMetadataManager, createTimeoutPromise, detectDialect, extractSchemaFromEntities, extractSchemaFromEntity, extractTableDefinition, generateSchemaFromDefinition, generateTypes, getDefaultHealthCheckConfig, getDialect, getEntityColumns, getEntityTableName, isRetryableError, metadataStorage, mysqlDialect, postgresDialect, propertyToColumn, registerSignalHandlers, sqliteDialect, validateTenantContext, validateTenantContextOrWarn, withRetry };
