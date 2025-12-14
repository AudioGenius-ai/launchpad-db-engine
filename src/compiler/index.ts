import type {
  CompiledQuery,
  DialectName,
  HavingClause,
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

interface CompilationState {
  params: unknown[];
  paramIndex: number;
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
    if (this.injectTenant && !ctx) {
      throw new Error('Tenant context is required when tenant injection is enabled');
    }

    const state: CompilationState = { params: [], paramIndex: 1 };

    let sql = this.compileSelectFrom(ast);
    sql += this.compileSelectJoins(ast);
    sql += this.compileSelectWhere(ast, ctx, state);
    sql += this.compileSelectGroupBy(ast);
    sql += this.compileSelectHaving(ast, state);
    sql += this.compileSelectOrderBy(ast);
    sql += this.compileSelectLimitOffset(ast);

    return { sql, params: state.params };
  }

  private compileSelectFrom(ast: QueryAST): string {
    const columns = ast.columns?.length
      ? ast.columns.map((c) => this.quoteIdentifier(c)).join(', ')
      : '*';
    return `SELECT ${columns} FROM ${this.quoteIdentifier(ast.table)}`;
  }

  private compileSelectJoins(ast: QueryAST): string {
    if (!ast.joins?.length) return '';

    return ast.joins
      .map((join) => {
        const alias = join.alias ? ` AS ${this.quoteIdentifier(join.alias)}` : '';
        return ` ${join.type} JOIN ${this.quoteIdentifier(join.table)}${alias} ON ${this.quoteIdentifier(join.on.leftColumn)} = ${this.quoteIdentifier(join.on.rightColumn)}`;
      })
      .join('');
  }

  private compileSelectWhere(
    ast: QueryAST,
    ctx: TenantContext | undefined,
    state: CompilationState
  ): string {
    const predicates = this.buildWherePredicates(ast, ctx, state);
    if (predicates.length === 0) return '';
    return ` WHERE ${this.joinPredicates(predicates, ast.where || [])}`;
  }

  private buildWherePredicates(
    ast: QueryAST,
    ctx: TenantContext | undefined,
    state: CompilationState
  ): string[] {
    const predicates: string[] = [];

    if (this.injectTenant && ctx) {
      const tablePrefix = ast.joins?.length ? `${ast.table}.` : '';
      predicates.push(
        `${this.quoteIdentifier(`${tablePrefix}${this.tenantColumns.appId}`)} = ${this.getParamPlaceholder(state.paramIndex++)}`
      );
      state.params.push(ctx.appId);
      predicates.push(
        `${this.quoteIdentifier(`${tablePrefix}${this.tenantColumns.organizationId}`)} = ${this.getParamPlaceholder(state.paramIndex++)}`
      );
      state.params.push(ctx.organizationId);
    }

    if (ast.where?.length) {
      for (const w of ast.where) {
        const { predicate, values, paramCount } = this.compileWhere(w, state.paramIndex);
        predicates.push(predicate);
        state.params.push(...values);
        state.paramIndex += paramCount;
      }
    }

    return predicates;
  }

  private compileSelectGroupBy(ast: QueryAST): string {
    if (!ast.groupBy?.columns.length) return '';
    return ` GROUP BY ${ast.groupBy.columns.map((c) => this.quoteIdentifier(c)).join(', ')}`;
  }

  private compileSelectHaving(ast: QueryAST, state: CompilationState): string {
    if (!ast.having?.length) return '';

    const havingClauses: string[] = [];
    for (const h of ast.having) {
      const { predicate, values, paramCount } = this.compileHaving(h, state.paramIndex);
      havingClauses.push(predicate);
      state.params.push(...values);
      state.paramIndex += paramCount;
    }
    return ` HAVING ${havingClauses.join(' AND ')}`;
  }

  private compileSelectOrderBy(ast: QueryAST): string {
    if (!ast.orderBy) return '';

    const direction = ast.orderBy.direction.toUpperCase();
    if (direction !== 'ASC' && direction !== 'DESC') {
      throw new Error(
        `Invalid ORDER BY direction: ${ast.orderBy.direction}. Must be 'ASC' or 'DESC'.`
      );
    }
    return ` ORDER BY ${this.quoteIdentifier(ast.orderBy.column)} ${direction}`;
  }

  private compileSelectLimitOffset(ast: QueryAST): string {
    let sql = '';
    if (ast.limit !== undefined) {
      sql += ` LIMIT ${ast.limit}`;
    }
    if (ast.offset !== undefined) {
      sql += ` OFFSET ${ast.offset}`;
    }
    return sql;
  }

  private compileInsert(ast: QueryAST, ctx?: TenantContext): CompiledQuery {
    if (this.injectTenant && !ctx) {
      throw new Error('Tenant context is required when tenant injection is enabled');
    }

    const params: unknown[] = [];
    let paramIndex = 1;

    if (ast.dataRows !== undefined) {
      return this.compileInsertMany(ast, ctx, params, paramIndex);
    }

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

    if (ast.onConflict) {
      sql += this.compileOnConflict(ast.onConflict, columns, paramIndex, params);
    }

    if (ast.returning?.length) {
      sql += this.compileReturning(ast.returning);
    }

    return { sql, params };
  }

  private compileInsertMany(
    ast: QueryAST,
    ctx: TenantContext | undefined,
    params: unknown[],
    startParamIndex: number
  ): CompiledQuery {
    const rows = ast.dataRows!.map((row) => {
      const data = { ...row };
      if (this.injectTenant && ctx) {
        data[this.tenantColumns.appId] = ctx.appId;
        data[this.tenantColumns.organizationId] = ctx.organizationId;
      }
      return data;
    });

    if (rows.length === 0) {
      throw new Error('Cannot insert empty array of rows');
    }

    const columns = Object.keys(rows[0]);
    const valueGroups: string[] = [];
    let currentParamIndex = startParamIndex;

    for (const row of rows) {
      const values: string[] = [];
      for (const col of columns) {
        values.push(this.getParamPlaceholder(currentParamIndex++));
        params.push(row[col]);
      }
      valueGroups.push(`(${values.join(', ')})`);
    }

    let sql = `INSERT INTO ${this.quoteIdentifier(ast.table)} (${columns.map((c) => this.quoteIdentifier(c)).join(', ')}) VALUES ${valueGroups.join(', ')}`;

    if (ast.onConflict) {
      sql += this.compileOnConflict(ast.onConflict, columns, currentParamIndex, params);
    }

    if (ast.returning?.length) {
      sql += this.compileReturning(ast.returning);
    }

    return { sql, params };
  }

  private compileOnConflict(
    conflict: QueryAST['onConflict'],
    columns: string[],
    _paramIndex: number,
    _params: unknown[]
  ): string {
    if (!conflict) return '';

    const conflictCols = conflict.columns.map((c) => this.quoteIdentifier(c)).join(', ');

    switch (this.dialect) {
      case 'postgresql':
      case 'sqlite': {
        if (conflict.action === 'nothing') {
          return ` ON CONFLICT (${conflictCols}) DO NOTHING`;
        }
        const updateCols =
          conflict.updateColumns || columns.filter((c) => !conflict.columns.includes(c));
        const setClauses = updateCols.map(
          (c) => `${this.quoteIdentifier(c)} = EXCLUDED.${this.quoteIdentifier(c)}`
        );
        return ` ON CONFLICT (${conflictCols}) DO UPDATE SET ${setClauses.join(', ')}`;
      }
      case 'mysql': {
        if (conflict.action === 'nothing') {
          return ' ON DUPLICATE KEY UPDATE id = id';
        }
        const updateCols =
          conflict.updateColumns || columns.filter((c) => !conflict.columns.includes(c));
        const setClauses = updateCols.map(
          (c) => `${this.quoteIdentifier(c)} = VALUES(${this.quoteIdentifier(c)})`
        );
        return ` ON DUPLICATE KEY UPDATE ${setClauses.join(', ')}`;
      }
      default:
        throw new Error(`Unsupported dialect for ON CONFLICT: ${this.dialect}`);
    }
  }

  private compileUpdate(ast: QueryAST, ctx?: TenantContext): CompiledQuery {
    if (this.injectTenant && !ctx) {
      throw new Error('Tenant context is required when tenant injection is enabled');
    }

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
    if (this.injectTenant && !ctx) {
      throw new Error('Tenant context is required when tenant injection is enabled');
    }

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

  private compileWhere(
    w: WhereClause,
    paramIndex: number
  ): { predicate: string; values: unknown[]; paramCount: number } {
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

  private joinPredicates(predicates: string[], whereClauses: WhereClause[]): string {
    if (predicates.length === 0) return '';

    const tenantPredicateCount = this.injectTenant ? 2 : 0;
    const result = predicates.map((predicate, i) => {
      if (i < tenantPredicateCount) return predicate;
      const clause = whereClauses[i - tenantPredicateCount];
      return clause?.connector === 'OR' ? `OR ${predicate}` : predicate;
    });

    return result.reduce((sql, part, i) => {
      if (i === 0) return part;
      return part.startsWith('OR ') ? `${sql} ${part}` : `${sql} AND ${part}`;
    }, '');
  }

  private compileHaving(
    h: HavingClause,
    paramIndex: number
  ): { predicate: string; values: unknown[]; paramCount: number } {
    const col = this.quoteIdentifier(h.column);
    return {
      predicate: `${col} ${h.op} ${this.getParamPlaceholder(paramIndex)}`,
      values: [h.value],
      paramCount: 1,
    };
  }

  private quoteIdentifier(identifier: string): string {
    if (identifier === '*') return identifier;
    // Don't quote SQL expressions (functions, aliases, etc.)
    if (identifier.includes('(') || identifier.toLowerCase().includes(' as ')) {
      return identifier;
    }
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
