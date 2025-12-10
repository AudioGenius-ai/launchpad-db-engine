import type {
  QueryAST,
  TenantContext,
  CompiledQuery,
  DialectName,
  WhereClause,
} from '../types/index.js';

export interface CompilerOptions {
  dialect: DialectName;
  injectTenant?: boolean;
  tenantColumns?: {
    appId: string;
    organizationId: string;
  };
}

const DEFAULT_TENANT_COLUMNS = {
  appId: 'app_id',
  organizationId: 'organization_id',
};

export class SQLCompiler {
  private dialect: DialectName;
  private injectTenant: boolean;
  private tenantColumns: { appId: string; organizationId: string };

  constructor(options: CompilerOptions) {
    this.dialect = options.dialect;
    this.injectTenant = options.injectTenant ?? true;
    this.tenantColumns = options.tenantColumns ?? DEFAULT_TENANT_COLUMNS;
  }

  compile(ast: QueryAST, ctx?: TenantContext): CompiledQuery {
    switch (ast.type) {
      case 'select':
        return this.compileSelect(ast, ctx);
      case 'insert':
        return this.compileInsert(ast, ctx);
      case 'update':
        return this.compileUpdate(ast, ctx);
      case 'delete':
        return this.compileDelete(ast, ctx);
      default:
        throw new Error(`Unsupported query type: ${(ast as QueryAST).type}`);
    }
  }

  private getParamPlaceholder(index: number): string {
    switch (this.dialect) {
      case 'postgresql':
        return `$${index}`;
      case 'mysql':
      case 'sqlite':
        return '?';
      default:
        return `$${index}`;
    }
  }

  private compileSelect(ast: QueryAST, ctx?: TenantContext): CompiledQuery {
    const params: unknown[] = [];
    let paramIndex = 1;

    const columns = ast.columns?.length ? ast.columns.join(', ') : '*';
    let sql = `SELECT ${columns} FROM ${this.quoteIdentifier(ast.table)}`;

    if (ast.joins?.length) {
      for (const join of ast.joins) {
        const alias = join.alias ? ` AS ${this.quoteIdentifier(join.alias)}` : '';
        sql += ` ${join.type} JOIN ${this.quoteIdentifier(join.table)}${alias}`;
        sql += ` ON ${join.on.leftColumn} = ${join.on.rightColumn}`;
      }
    }

    const predicates: string[] = [];

    if (this.injectTenant && ctx) {
      predicates.push(`${this.quoteIdentifier(this.tenantColumns.appId)} = ${this.getParamPlaceholder(paramIndex++)}`);
      params.push(ctx.appId);
      predicates.push(`${this.quoteIdentifier(this.tenantColumns.organizationId)} = ${this.getParamPlaceholder(paramIndex++)}`);
      params.push(ctx.organizationId);
    }

    if (ast.where?.length) {
      for (const w of ast.where) {
        const { predicate, value } = this.compileWhere(w, paramIndex);
        predicates.push(predicate);
        if (value !== undefined) {
          params.push(value);
          paramIndex++;
        }
      }
    }

    if (predicates.length) {
      sql += ` WHERE ${predicates.join(' AND ')}`;
    }

    if (ast.orderBy) {
      sql += ` ORDER BY ${this.quoteIdentifier(ast.orderBy.column)} ${ast.orderBy.direction.toUpperCase()}`;
    }

    if (ast.limit !== undefined) {
      sql += ` LIMIT ${ast.limit}`;
    }

    if (ast.offset !== undefined) {
      sql += ` OFFSET ${ast.offset}`;
    }

    return { sql, params };
  }

  private compileInsert(ast: QueryAST, ctx?: TenantContext): CompiledQuery {
    const params: unknown[] = [];
    let paramIndex = 1;

    const data = { ...ast.data };

    if (this.injectTenant && ctx) {
      data[this.tenantColumns.appId] = ctx.appId;
      data[this.tenantColumns.organizationId] = ctx.organizationId;
    }

    const columns = Object.keys(data!);
    const values: string[] = [];

    for (const col of columns) {
      values.push(this.getParamPlaceholder(paramIndex++));
      params.push(data![col]);
    }

    let sql = `INSERT INTO ${this.quoteIdentifier(ast.table)} (${columns.map(c => this.quoteIdentifier(c)).join(', ')}) VALUES (${values.join(', ')})`;

    if (ast.returning?.length) {
      if (this.dialect === 'postgresql') {
        sql += ` RETURNING ${ast.returning.map(c => this.quoteIdentifier(c)).join(', ')}`;
      }
    }

    return { sql, params };
  }

  private compileUpdate(ast: QueryAST, ctx?: TenantContext): CompiledQuery {
    const params: unknown[] = [];
    let paramIndex = 1;

    const setClauses: string[] = [];
    for (const [key, value] of Object.entries(ast.data!)) {
      setClauses.push(`${this.quoteIdentifier(key)} = ${this.getParamPlaceholder(paramIndex++)}`);
      params.push(value);
    }

    let sql = `UPDATE ${this.quoteIdentifier(ast.table)} SET ${setClauses.join(', ')}`;

    const predicates: string[] = [];

    if (this.injectTenant && ctx) {
      predicates.push(`${this.quoteIdentifier(this.tenantColumns.appId)} = ${this.getParamPlaceholder(paramIndex++)}`);
      params.push(ctx.appId);
      predicates.push(`${this.quoteIdentifier(this.tenantColumns.organizationId)} = ${this.getParamPlaceholder(paramIndex++)}`);
      params.push(ctx.organizationId);
    }

    if (ast.where?.length) {
      for (const w of ast.where) {
        const { predicate, value } = this.compileWhere(w, paramIndex);
        predicates.push(predicate);
        if (value !== undefined) {
          params.push(value);
          paramIndex++;
        }
      }
    }

    if (predicates.length) {
      sql += ` WHERE ${predicates.join(' AND ')}`;
    }

    if (ast.returning?.length && this.dialect === 'postgresql') {
      sql += ` RETURNING ${ast.returning.map(c => this.quoteIdentifier(c)).join(', ')}`;
    }

    return { sql, params };
  }

  private compileDelete(ast: QueryAST, ctx?: TenantContext): CompiledQuery {
    const params: unknown[] = [];
    let paramIndex = 1;

    let sql = `DELETE FROM ${this.quoteIdentifier(ast.table)}`;

    const predicates: string[] = [];

    if (this.injectTenant && ctx) {
      predicates.push(`${this.quoteIdentifier(this.tenantColumns.appId)} = ${this.getParamPlaceholder(paramIndex++)}`);
      params.push(ctx.appId);
      predicates.push(`${this.quoteIdentifier(this.tenantColumns.organizationId)} = ${this.getParamPlaceholder(paramIndex++)}`);
      params.push(ctx.organizationId);
    }

    if (ast.where?.length) {
      for (const w of ast.where) {
        const { predicate, value } = this.compileWhere(w, paramIndex);
        predicates.push(predicate);
        if (value !== undefined) {
          params.push(value);
          paramIndex++;
        }
      }
    }

    if (predicates.length) {
      sql += ` WHERE ${predicates.join(' AND ')}`;
    }

    if (ast.returning?.length && this.dialect === 'postgresql') {
      sql += ` RETURNING ${ast.returning.map(c => this.quoteIdentifier(c)).join(', ')}`;
    }

    return { sql, params };
  }

  private compileWhere(w: WhereClause, paramIndex: number): { predicate: string; value?: unknown } {
    const col = this.quoteIdentifier(w.column);

    switch (w.op) {
      case 'IS NULL':
        return { predicate: `${col} IS NULL` };
      case 'IS NOT NULL':
        return { predicate: `${col} IS NOT NULL` };
      case 'IN':
      case 'NOT IN': {
        const values = w.value as unknown[];
        const placeholders = values.map((_, i) => this.getParamPlaceholder(paramIndex + i)).join(', ');
        return { predicate: `${col} ${w.op} (${placeholders})`, value: values };
      }
      default:
        return {
          predicate: `${col} ${w.op} ${this.getParamPlaceholder(paramIndex)}`,
          value: w.value,
        };
    }
  }

  private quoteIdentifier(identifier: string): string {
    if (identifier === '*') return identifier;
    if (identifier.includes('.')) {
      return identifier.split('.').map(part => this.quoteIdentifier(part)).join('.');
    }

    switch (this.dialect) {
      case 'postgresql':
        return `"${identifier}"`;
      case 'mysql':
        return `\`${identifier}\``;
      case 'sqlite':
        return `"${identifier}"`;
      default:
        return `"${identifier}"`;
    }
  }
}

export function createCompiler(options: CompilerOptions): SQLCompiler {
  return new SQLCompiler(options);
}
