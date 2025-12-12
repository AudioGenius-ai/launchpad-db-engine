import type {
  CompiledQuery,
  DialectName,
  QueryAST,
  TenantContext,
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
      predicates.push(
        `${this.quoteIdentifier(this.tenantColumns.appId)} = ${this.getParamPlaceholder(paramIndex++)}`
      );
      params.push(ctx.appId);
      predicates.push(
        `${this.quoteIdentifier(this.tenantColumns.organizationId)} = ${this.getParamPlaceholder(paramIndex++)}`
      );
      params.push(ctx.organizationId);
    }

    if (ast.where?.length) {
      for (const w of ast.where) {
        const { predicate, values, paramCount } = this.compileWhere(w, paramIndex);
        predicates.push(predicate);
        params.push(...values);
        paramIndex += paramCount;
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

    let sql = `INSERT INTO ${this.quoteIdentifier(ast.table)} (${columns.map((c) => this.quoteIdentifier(c)).join(', ')}) VALUES (${values.join(', ')})`;

    if (ast.returning?.length) {
      sql += this.compileReturning(ast.returning);
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
      predicates.push(
        `${this.quoteIdentifier(this.tenantColumns.appId)} = ${this.getParamPlaceholder(paramIndex++)}`
      );
      params.push(ctx.appId);
      predicates.push(
        `${this.quoteIdentifier(this.tenantColumns.organizationId)} = ${this.getParamPlaceholder(paramIndex++)}`
      );
      params.push(ctx.organizationId);
    }

    if (ast.where?.length) {
      for (const w of ast.where) {
        const { predicate, values, paramCount } = this.compileWhere(w, paramIndex);
        predicates.push(predicate);
        params.push(...values);
        paramIndex += paramCount;
      }
    }

    if (predicates.length) {
      sql += ` WHERE ${predicates.join(' AND ')}`;
    }

    if (ast.returning?.length) {
      sql += this.compileReturning(ast.returning);
    }

    return { sql, params };
  }

  private compileDelete(ast: QueryAST, ctx?: TenantContext): CompiledQuery {
    const params: unknown[] = [];
    let paramIndex = 1;

    let sql = `DELETE FROM ${this.quoteIdentifier(ast.table)}`;

    const predicates: string[] = [];

    if (this.injectTenant && ctx) {
      predicates.push(
        `${this.quoteIdentifier(this.tenantColumns.appId)} = ${this.getParamPlaceholder(paramIndex++)}`
      );
      params.push(ctx.appId);
      predicates.push(
        `${this.quoteIdentifier(this.tenantColumns.organizationId)} = ${this.getParamPlaceholder(paramIndex++)}`
      );
      params.push(ctx.organizationId);
    }

    if (ast.where?.length) {
      for (const w of ast.where) {
        const { predicate, values, paramCount } = this.compileWhere(w, paramIndex);
        predicates.push(predicate);
        params.push(...values);
        paramIndex += paramCount;
      }
    }

    if (predicates.length) {
      sql += ` WHERE ${predicates.join(' AND ')}`;
    }

    if (ast.returning?.length) {
      sql += this.compileReturning(ast.returning);
    }

    return { sql, params };
  }

  private compileReturning(columns: string[]): string {
    switch (this.dialect) {
      case 'postgresql':
      case 'sqlite':
        return ` RETURNING ${columns.map((c) => this.quoteIdentifier(c)).join(', ')}`;
      case 'mysql':
        throw new Error(
          'MySQL does not support RETURNING clause. Use separate SELECT query after INSERT/UPDATE/DELETE.'
        );
      default:
        throw new Error(`Unsupported dialect for RETURNING: ${this.dialect}`);
    }
  }

  private compileWhere(w: WhereClause, paramIndex: number): { predicate: string; values: unknown[]; paramCount: number } {
    const col = this.quoteIdentifier(w.column);

    switch (w.op) {
      case 'IS NULL':
        return { predicate: `${col} IS NULL`, values: [], paramCount: 0 };
      case 'IS NOT NULL':
        return { predicate: `${col} IS NOT NULL`, values: [], paramCount: 0 };
      case 'IN':
      case 'NOT IN': {
        const inValues = w.value as unknown[];
        if (inValues.length === 0) {
          return {
            predicate: w.op === 'IN' ? '1 = 0' : '1 = 1',
            values: [],
            paramCount: 0,
          };
        }
        const placeholders = inValues
          .map((_, i) => this.getParamPlaceholder(paramIndex + i))
          .join(', ');
        return {
          predicate: `${col} ${w.op} (${placeholders})`,
          values: inValues,
          paramCount: inValues.length,
        };
      }
      default:
        return {
          predicate: `${col} ${w.op} ${this.getParamPlaceholder(paramIndex)}`,
          values: w.value !== undefined ? [w.value] : [],
          paramCount: w.value !== undefined ? 1 : 0,
        };
    }
  }

  private quoteIdentifier(identifier: string): string {
    if (identifier === '*') return identifier;
    if (identifier.includes('.')) {
      return identifier
        .split('.')
        .map((part) => this.quoteIdentifier(part))
        .join('.');
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
