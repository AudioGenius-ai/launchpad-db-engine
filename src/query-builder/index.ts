import type { Driver, TransactionClient } from '../driver/types.js';
import type {
  TenantContext,
  QueryAST,
  Operator,
} from '../types/index.js';
import { SQLCompiler } from '../compiler/index.js';

export class SelectBuilder<T = Record<string, unknown>> {
  private ast: QueryAST;
  private driver: Driver | TransactionClient;
  private compiler: SQLCompiler;
  private ctx?: TenantContext;

  constructor(
    driver: Driver | TransactionClient,
    compiler: SQLCompiler,
    table: string,
    ctx?: TenantContext
  ) {
    this.driver = driver;
    this.compiler = compiler;
    this.ctx = ctx;
    this.ast = {
      type: 'select',
      table,
      columns: ['*'],
      where: [],
    };
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
    const { sql, params } = this.compiler.compile(this.ast, this.ctx);
    const result = await this.driver.query<T>(sql, params);
    return result.rows;
  }

  async first(): Promise<T | null> {
    this.limit(1);
    const rows = await this.execute();
    return rows[0] ?? null;
  }

  async count(): Promise<number> {
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

  constructor(
    driver: Driver | TransactionClient,
    compiler: SQLCompiler,
    table: string,
    ctx?: TenantContext
  ) {
    this.driver = driver;
    this.compiler = compiler;
    this.ctx = ctx;
    this.ast = {
      type: 'insert',
      table,
      data: {},
    };
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

  constructor(
    driver: Driver | TransactionClient,
    compiler: SQLCompiler,
    table: string,
    ctx?: TenantContext
  ) {
    this.driver = driver;
    this.compiler = compiler;
    this.ctx = ctx;
    this.ast = {
      type: 'update',
      table,
      data: {},
      where: [],
    };
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

  constructor(
    driver: Driver | TransactionClient,
    compiler: SQLCompiler,
    table: string,
    ctx?: TenantContext
  ) {
    this.driver = driver;
    this.compiler = compiler;
    this.ctx = ctx;
    this.ast = {
      type: 'delete',
      table,
      where: [],
    };
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

  constructor(
    driver: Driver | TransactionClient,
    compiler: SQLCompiler,
    table: string,
    ctx?: TenantContext
  ) {
    this.driver = driver;
    this.compiler = compiler;
    this.tableName = table;
    this.ctx = ctx;
  }

  select<K extends keyof T>(...columns: K[]): SelectBuilder<T> {
    const builder = new SelectBuilder<T>(this.driver, this.compiler, this.tableName, this.ctx);
    if (columns.length) {
      builder.select(...columns);
    }
    return builder;
  }

  insert(): InsertBuilder<T> {
    return new InsertBuilder<T>(this.driver, this.compiler, this.tableName, this.ctx);
  }

  update(): UpdateBuilder<T> {
    return new UpdateBuilder<T>(this.driver, this.compiler, this.tableName, this.ctx);
  }

  delete(): DeleteBuilder<T> {
    return new DeleteBuilder<T>(this.driver, this.compiler, this.tableName, this.ctx);
  }

  async findById(id: string | number): Promise<T | null> {
    return this.select().where('id' as keyof T, '=', id).first();
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
