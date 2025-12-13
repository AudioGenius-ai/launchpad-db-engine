import type { SQLCompiler } from '../compiler/index.js';
import type { Driver, TransactionClient } from '../driver/types.js';
import type { Operator, QueryAST, TenantContext } from '../types/index.js';
import { validateTenantContextOrWarn } from '../utils/tenant-validation.js';

export class SelectBuilder<T = Record<string, unknown>> {
  private ast: QueryAST;
  private driver: Driver | TransactionClient;
  private compiler: SQLCompiler;
  private ctx?: TenantContext;
  private tenantValidated = false;
  private shouldValidateTenant: boolean;

  constructor(
    driver: Driver | TransactionClient,
    compiler: SQLCompiler,
    table: string,
    ctx?: TenantContext,
    shouldValidateTenant = true
  ) {
    this.driver = driver;
    this.compiler = compiler;
    this.ctx = ctx;
    this.shouldValidateTenant = shouldValidateTenant;
    this.ast = {
      type: 'select',
      table,
      columns: ['*'],
      where: [],
    };
  }

  private validateTenantOnce(): void {
    if (!this.tenantValidated && this.shouldValidateTenant) {
      validateTenantContextOrWarn(this.ctx, this.ast.table);
      this.tenantValidated = true;
    }
  }

  select<K extends keyof T>(...columns: K[]): this {
    this.ast.columns = columns as string[];
    return this;
  }

  where(column: keyof T, op: Operator, value: unknown): this {
    this.ast.where = this.ast.where ?? [];
    this.ast.where.push({ column: column as string, op, value });
    return this;
  }

  whereNull(column: keyof T): this {
    this.ast.where = this.ast.where ?? [];
    this.ast.where.push({ column: column as string, op: 'IS NULL', value: null });
    return this;
  }

  whereNotNull(column: keyof T): this {
    this.ast.where = this.ast.where ?? [];
    this.ast.where.push({ column: column as string, op: 'IS NOT NULL', value: null });
    return this;
  }

  whereIn(column: keyof T, values: unknown[]): this {
    this.ast.where = this.ast.where ?? [];
    this.ast.where.push({ column: column as string, op: 'IN', value: values });
    return this;
  }

  orderBy(column: keyof T, direction: 'asc' | 'desc' = 'asc'): this {
    this.ast.orderBy = { column: column as string, direction };
    return this;
  }

  limit(n: number): this {
    this.ast.limit = n;
    return this;
  }

  offset(n: number): this {
    this.ast.offset = n;
    return this;
  }

  join(
    type: 'INNER' | 'LEFT' | 'RIGHT' | 'FULL',
    table: string,
    leftColumn: string,
    rightColumn: string,
    alias?: string
  ): this {
    this.ast.joins = this.ast.joins ?? [];
    this.ast.joins.push({
      type,
      table,
      alias,
      on: { leftColumn, rightColumn },
    });
    return this;
  }

  innerJoin(table: string, leftColumn: string, rightColumn: string, alias?: string): this {
    return this.join('INNER', table, leftColumn, rightColumn, alias);
  }

  leftJoin(table: string, leftColumn: string, rightColumn: string, alias?: string): this {
    return this.join('LEFT', table, leftColumn, rightColumn, alias);
  }

  async execute(): Promise<T[]> {
    this.validateTenantOnce();
    const { sql, params } = this.compiler.compile(this.ast, this.ctx);
    const result = await this.driver.query<T>(sql, params);
    return result.rows;
  }

  async first(): Promise<T | null> {
    this.validateTenantOnce();
    this.limit(1);
    const rows = await this.execute();
    return rows[0] ?? null;
  }

  async count(): Promise<number> {
    this.validateTenantOnce();
    const originalColumns = this.ast.columns;
    this.ast.columns = ['COUNT(*) as count'];
    const { sql, params } = this.compiler.compile(this.ast, this.ctx);
    const result = await this.driver.query<{ count: number | string }>(sql, params);
    this.ast.columns = originalColumns;
    return Number(result.rows[0]?.count ?? 0);
  }

  toSQL(): { sql: string; params: unknown[] } {
    return this.compiler.compile(this.ast, this.ctx);
  }
}

export class InsertBuilder<T = Record<string, unknown>> {
  private ast: QueryAST;
  private driver: Driver | TransactionClient;
  private compiler: SQLCompiler;
  private ctx?: TenantContext;
  private tenantValidated = false;
  private shouldValidateTenant: boolean;

  constructor(
    driver: Driver | TransactionClient,
    compiler: SQLCompiler,
    table: string,
    ctx?: TenantContext,
    shouldValidateTenant = true
  ) {
    this.driver = driver;
    this.compiler = compiler;
    this.ctx = ctx;
    this.shouldValidateTenant = shouldValidateTenant;
    this.ast = {
      type: 'insert',
      table,
      data: {},
    };
  }

  private validateTenantOnce(): void {
    if (!this.tenantValidated && this.shouldValidateTenant) {
      validateTenantContextOrWarn(this.ctx, this.ast.table);
      this.tenantValidated = true;
    }
  }

  values(data: Partial<Omit<T, 'app_id' | 'organization_id'>>): this {
    this.ast.data = data as Record<string, unknown>;
    return this;
  }

  returning<K extends keyof T>(...columns: K[]): this {
    this.ast.returning = columns as string[];
    return this;
  }

  async execute(): Promise<T[]> {
    this.validateTenantOnce();
    const { sql, params } = this.compiler.compile(this.ast, this.ctx);
    if (this.ast.returning?.length) {
      const result = await this.driver.query<T>(sql, params);
      return result.rows;
    }
    await this.driver.execute(sql, params);
    return [];
  }

  toSQL(): { sql: string; params: unknown[] } {
    return this.compiler.compile(this.ast, this.ctx);
  }
}

export class UpdateBuilder<T = Record<string, unknown>> {
  private ast: QueryAST;
  private driver: Driver | TransactionClient;
  private compiler: SQLCompiler;
  private ctx?: TenantContext;
  private tenantValidated = false;
  private shouldValidateTenant: boolean;

  constructor(
    driver: Driver | TransactionClient,
    compiler: SQLCompiler,
    table: string,
    ctx?: TenantContext,
    shouldValidateTenant = true
  ) {
    this.driver = driver;
    this.compiler = compiler;
    this.ctx = ctx;
    this.shouldValidateTenant = shouldValidateTenant;
    this.ast = {
      type: 'update',
      table,
      data: {},
      where: [],
    };
  }

  private validateTenantOnce(): void {
    if (!this.tenantValidated && this.shouldValidateTenant) {
      validateTenantContextOrWarn(this.ctx, this.ast.table);
      this.tenantValidated = true;
    }
  }

  set(data: Partial<Omit<T, 'app_id' | 'organization_id' | 'id' | 'created_at'>>): this {
    this.ast.data = data as Record<string, unknown>;
    return this;
  }

  where(column: keyof T, op: Operator, value: unknown): this {
    this.ast.where = this.ast.where ?? [];
    this.ast.where.push({ column: column as string, op, value });
    return this;
  }

  returning<K extends keyof T>(...columns: K[]): this {
    this.ast.returning = columns as string[];
    return this;
  }

  async execute(): Promise<T[]> {
    this.validateTenantOnce();
    const { sql, params } = this.compiler.compile(this.ast, this.ctx);
    if (this.ast.returning?.length) {
      const result = await this.driver.query<T>(sql, params);
      return result.rows;
    }
    await this.driver.execute(sql, params);
    return [];
  }

  toSQL(): { sql: string; params: unknown[] } {
    return this.compiler.compile(this.ast, this.ctx);
  }
}

export class DeleteBuilder<T = Record<string, unknown>> {
  private ast: QueryAST;
  private driver: Driver | TransactionClient;
  private compiler: SQLCompiler;
  private ctx?: TenantContext;
  private tenantValidated = false;
  private shouldValidateTenant: boolean;

  constructor(
    driver: Driver | TransactionClient,
    compiler: SQLCompiler,
    table: string,
    ctx?: TenantContext,
    shouldValidateTenant = true
  ) {
    this.driver = driver;
    this.compiler = compiler;
    this.ctx = ctx;
    this.shouldValidateTenant = shouldValidateTenant;
    this.ast = {
      type: 'delete',
      table,
      where: [],
    };
  }

  private validateTenantOnce(): void {
    if (!this.tenantValidated && this.shouldValidateTenant) {
      validateTenantContextOrWarn(this.ctx, this.ast.table);
      this.tenantValidated = true;
    }
  }

  where(column: keyof T, op: Operator, value: unknown): this {
    this.ast.where = this.ast.where ?? [];
    this.ast.where.push({ column: column as string, op, value });
    return this;
  }

  returning<K extends keyof T>(...columns: K[]): this {
    this.ast.returning = columns as string[];
    return this;
  }

  async execute(): Promise<T[]> {
    this.validateTenantOnce();
    const { sql, params } = this.compiler.compile(this.ast, this.ctx);
    if (this.ast.returning?.length) {
      const result = await this.driver.query<T>(sql, params);
      return result.rows;
    }
    await this.driver.execute(sql, params);
    return [];
  }

  toSQL(): { sql: string; params: unknown[] } {
    return this.compiler.compile(this.ast, this.ctx);
  }
}

export class TableBuilder<T = Record<string, unknown>> {
  private driver: Driver | TransactionClient;
  private compiler: SQLCompiler;
  private tableName: string;
  private ctx?: TenantContext;
  private shouldValidateTenant: boolean;
  private whereConditions: Array<{ column: string; op: Operator; value: unknown }> = [];
  private orderByClause?: { column: string; direction: 'asc' | 'desc' };
  private limitValue?: number;
  private offsetValue?: number;

  constructor(
    driver: Driver | TransactionClient,
    compiler: SQLCompiler,
    table: string,
    ctx?: TenantContext,
    shouldValidateTenant = true
  ) {
    this.driver = driver;
    this.compiler = compiler;
    this.tableName = table;
    this.ctx = ctx;
    this.shouldValidateTenant = shouldValidateTenant;
  }

  where(column: keyof T, op: Operator, value: unknown): this {
    this.whereConditions.push({ column: column as string, op, value });
    return this;
  }

  whereNull(column: keyof T): this {
    this.whereConditions.push({ column: column as string, op: 'IS NULL', value: null });
    return this;
  }

  whereNotNull(column: keyof T): this {
    this.whereConditions.push({ column: column as string, op: 'IS NOT NULL', value: null });
    return this;
  }

  whereIn(column: keyof T, values: unknown[]): this {
    this.whereConditions.push({ column: column as string, op: 'IN', value: values });
    return this;
  }

  orderBy(column: keyof T, direction: 'asc' | 'desc' = 'asc'): this {
    this.orderByClause = { column: column as string, direction };
    return this;
  }

  limit(n: number): this {
    this.limitValue = n;
    return this;
  }

  offset(n: number): this {
    this.offsetValue = n;
    return this;
  }

  select<K extends keyof T>(...columns: K[]): SelectBuilder<T> {
    const builder = new SelectBuilder<T>(this.driver, this.compiler, this.tableName, this.ctx, this.shouldValidateTenant);
    if (columns.length) {
      builder.select(...columns);
    }
    for (const w of this.whereConditions) {
      builder.where(w.column as keyof T, w.op, w.value);
    }
    if (this.orderByClause) {
      builder.orderBy(this.orderByClause.column as keyof T, this.orderByClause.direction);
    }
    if (this.limitValue !== undefined) {
      builder.limit(this.limitValue);
    }
    if (this.offsetValue !== undefined) {
      builder.offset(this.offsetValue);
    }
    return builder;
  }

  insert(): InsertBuilder<T> {
    return new InsertBuilder<T>(this.driver, this.compiler, this.tableName, this.ctx, this.shouldValidateTenant);
  }

  update(
    data?: Partial<Omit<T, 'app_id' | 'organization_id' | 'id' | 'created_at'>>
  ): UpdateBuilder<T> {
    const builder = new UpdateBuilder<T>(this.driver, this.compiler, this.tableName, this.ctx, this.shouldValidateTenant);
    if (data) {
      builder.set(data);
    }
    for (const w of this.whereConditions) {
      builder.where(w.column as keyof T, w.op, w.value);
    }
    return builder;
  }

  delete(): DeleteBuilder<T> {
    const builder = new DeleteBuilder<T>(this.driver, this.compiler, this.tableName, this.ctx, this.shouldValidateTenant);
    for (const w of this.whereConditions) {
      builder.where(w.column as keyof T, w.op, w.value);
    }
    return builder;
  }

  async findById(id: string | number): Promise<T | null> {
    return this.select()
      .where('id' as keyof T, '=', id)
      .first();
  }

  async findMany(options?: {
    where?: Array<{ column: keyof T; op: Operator; value: unknown }>;
    orderBy?: { column: keyof T; direction: 'asc' | 'desc' };
    limit?: number;
    offset?: number;
  }): Promise<T[]> {
    let builder = this.select();

    if (options?.where) {
      for (const w of options.where) {
        builder = builder.where(w.column, w.op, w.value);
      }
    }

    if (options?.orderBy) {
      builder = builder.orderBy(options.orderBy.column, options.orderBy.direction);
    }

    if (options?.limit !== undefined) {
      builder = builder.limit(options.limit);
    }

    if (options?.offset !== undefined) {
      builder = builder.offset(options.offset);
    }

    return builder.execute();
  }
}
