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
interface MigrationRecord {
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
    applied: MigrationRecord[];
    pending: MigrationFile[];
    current: number | null;
}
type DialectName = 'postgresql' | 'mysql' | 'sqlite';
interface QueryResult<T = Record<string, unknown>> {
    rows: T[];
    rowCount: number;
}

interface DriverConfig {
    connectionString: string;
    max?: number;
    idleTimeout?: number;
    connectTimeout?: number;
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
    table<T = Record<string, unknown>>(name: string, ctx: TenantContext): TableBuilder<T>;
    tableWithoutTenant<T = Record<string, unknown>>(name: string): TableBuilder<T>;
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
    constructor(client: TransactionClient, compiler: SQLCompiler, ctx: TenantContext);
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

interface CreateDriverOptions extends DriverConfig {
    dialect?: DialectName;
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

declare function createDb(options: {
    connectionString: string;
    migrationsPath?: string;
    tenantColumns?: {
        appId: string;
        organizationId: string;
    };
    strictTenantMode?: boolean;
}): Promise<DbClient>;

export { Column, type ColumnDefinition, type ColumnMetadata, type ColumnOptions, type ColumnType, type CompiledQuery, type CompilerOptions, type ConflictClause, type CreateDriverOptions, DbClient, type DbClientOptions, Default, DeleteBuilder, type Dialect, type DialectName, type Driver, type DriverConfig, Entity, type EntityConstructor, type EntityMetadata, type EntityOptions, type ExtractSchemaOptions, type FindOneOptions, type FindOptions, type GroupByClause, type HavingClause, Index, type IndexDefinition, type IndexOptions, InsertBuilder, type JoinClause, ManyToMany, ManyToOne, MigrationCollector, type MigrationCollectorOptions, type MigrationFile, type MigrationRecord, type MigrationResult, type MigrationRunOptions, MigrationRunner, type MigrationRunnerOptions, type MigrationStatus, type ModuleDefinition, type ModuleMigrationSource, ModuleRegistry, type ModuleRegistryOptions, Nullable, OneToMany, OneToOne, type Operator, type OrderByClause, PrimaryKey, type QueryAST, type QueryResult, type RegisterSchemaOptions, type RelationMetadata, Repository, SQLCompiler, type SchemaDefinition, SchemaRegistry, type SchemaRegistryOptions, SelectBuilder, TableBuilder, type TableDefinition, TenantColumn, type TenantContext, TenantContextError, TenantEntity, TenantTimestampedEntity, TimestampedEntity, type TransactionClient, TransactionContext, type TypeGeneratorOptions, Unique, UpdateBuilder, type WhereClause, type WhereCondition, WithTenantColumns, WithTimestamps, applyTenantColumns, applyTimestampColumns, columnToProperty, createCompiler, createDb, createDbClient, createDriver, createMigrationCollector, createMigrationRunner, createModuleRegistry, createRepository, createSchemaRegistry, detectDialect, extractSchemaFromEntities, extractSchemaFromEntity, extractTableDefinition, generateSchemaFromDefinition, generateTypes, getDialect, getEntityColumns, getEntityTableName, metadataStorage, mysqlDialect, postgresDialect, propertyToColumn, sqliteDialect, validateTenantContext, validateTenantContextOrWarn };
