import type {
  MongoOperation,
  Operator,
  QueryAST,
  TenantContext,
  WhereClause,
} from '../types/index.js';

export interface MongoCompilerOptions {
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

export class MongoCompiler {
  private injectTenant: boolean;
  private tenantColumns: { appId: string; organizationId: string };

  constructor(options: MongoCompilerOptions = {}) {
    this.injectTenant = options.injectTenant ?? true;
    this.tenantColumns = options.tenantColumns ?? DEFAULT_TENANT_COLUMNS;
  }

  compile(ast: QueryAST, ctx?: TenantContext): MongoOperation {
    if (this.injectTenant && !ctx) {
      throw new Error('Tenant context is required when tenant injection is enabled');
    }

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

  private compileSelect(ast: QueryAST, ctx?: TenantContext): MongoOperation {
    const hasJoins = ast.joins && ast.joins.length > 0;
    const hasGroupBy = ast.groupBy && ast.groupBy.columns.length > 0;
    const hasHaving = ast.having && ast.having.length > 0;

    if (hasJoins || hasGroupBy || hasHaving) {
      return this.compileSelectAggregate(ast, ctx);
    }

    return this.compileSelectFind(ast, ctx);
  }

  private compileSelectFind(ast: QueryAST, ctx?: TenantContext): MongoOperation {
    const filter = this.buildFilter(ast.where, ctx);
    const options: MongoOperation['options'] = {};

    if (ast.columns && !ast.columns.includes('*')) {
      const hasCountColumn = ast.columns.some((c) => c.toLowerCase().startsWith('count('));
      if (hasCountColumn) {
        return {
          type: 'countDocuments',
          collection: ast.table,
          filter,
        };
      }

      options.projection = {} as Record<string, 0 | 1>;
      for (const col of ast.columns) {
        (options.projection as Record<string, 1>)[col] = 1;
      }
    }

    if (ast.orderBy) {
      options.sort = {
        [ast.orderBy.column]: ast.orderBy.direction === 'desc' ? -1 : 1,
      } as Record<string, 1 | -1>;
    }

    if (ast.offset !== undefined) options.skip = ast.offset;
    if (ast.limit !== undefined) options.limit = ast.limit;

    return {
      type: 'find',
      collection: ast.table,
      filter,
      options: Object.keys(options).length > 0 ? options : undefined,
    };
  }

  private compileSelectAggregate(ast: QueryAST, ctx?: TenantContext): MongoOperation {
    const pipeline: Record<string, unknown>[] = [];

    const filter = this.buildFilter(ast.where, ctx);
    if (Object.keys(filter).length > 0) {
      pipeline.push({ $match: filter });
    }

    if (ast.joins) {
      for (const join of ast.joins) {
        const leftCol = join.on.leftColumn.split('.').pop()!;
        const rightCol = join.on.rightColumn.split('.').pop()!;

        pipeline.push({
          $lookup: {
            from: join.table,
            localField: leftCol,
            foreignField: rightCol,
            as: join.alias ?? join.table,
          },
        });

        if (join.type === 'INNER') {
          pipeline.push({ $unwind: `$${join.alias ?? join.table}` });
        } else if (join.type === 'LEFT') {
          pipeline.push({
            $unwind: {
              path: `$${join.alias ?? join.table}`,
              preserveNullAndEmptyArrays: true,
            },
          });
        }
      }
    }

    if (ast.groupBy && ast.groupBy.columns.length > 0) {
      const groupId =
        ast.groupBy.columns.length === 1
          ? `$${ast.groupBy.columns[0]}`
          : Object.fromEntries(ast.groupBy.columns.map((c) => [c, `$${c}`]));
      pipeline.push({ $group: { _id: groupId } });
    }

    if (ast.having && ast.having.length > 0) {
      const havingFilter: Record<string, unknown> = {};
      for (const h of ast.having) {
        havingFilter[h.column] = this.mapOperatorValue(h.op, h.value);
      }
      pipeline.push({ $match: havingFilter });
    }

    if (ast.orderBy) {
      pipeline.push({
        $sort: {
          [ast.orderBy.column]: ast.orderBy.direction === 'desc' ? -1 : 1,
        },
      });
    }

    if (ast.offset !== undefined) pipeline.push({ $skip: ast.offset });
    if (ast.limit !== undefined) pipeline.push({ $limit: ast.limit });

    if (ast.columns && !ast.columns.includes('*')) {
      const project: Record<string, 1> = {};
      for (const col of ast.columns) {
        if (!col.toLowerCase().startsWith('count(')) {
          project[col] = 1;
        }
      }
      if (Object.keys(project).length > 0) {
        pipeline.push({ $project: project });
      }
    }

    return {
      type: 'aggregate',
      collection: ast.table,
      pipeline,
    };
  }

  private compileInsert(ast: QueryAST, ctx?: TenantContext): MongoOperation {
    if (ast.dataRows && ast.dataRows.length > 0) {
      const documents = ast.dataRows.map((row) => this.injectTenantData(row, ctx));
      return {
        type: 'insertMany',
        collection: ast.table,
        documents,
      };
    }

    const document = this.injectTenantData(ast.data ?? {}, ctx);
    return {
      type: 'insertOne',
      collection: ast.table,
      document,
    };
  }

  private compileUpdate(ast: QueryAST, ctx?: TenantContext): MongoOperation {
    const filter = this.buildFilter(ast.where, ctx);
    const update = { $set: ast.data };

    if (ast.returning && ast.returning.length > 0) {
      const projection: Record<string, 1> = {};
      for (const col of ast.returning) {
        projection[col] = 1;
      }
      return {
        type: 'findOneAndUpdate',
        collection: ast.table,
        filter,
        update,
        options: {
          returnDocument: 'after',
          projection: projection as Record<string, 0 | 1>,
        },
      };
    }

    return {
      type: 'updateMany',
      collection: ast.table,
      filter,
      update,
    };
  }

  private compileDelete(ast: QueryAST, ctx?: TenantContext): MongoOperation {
    const filter = this.buildFilter(ast.where, ctx);

    if (ast.returning && ast.returning.length > 0) {
      const projection: Record<string, 1> = {};
      for (const col of ast.returning) {
        projection[col] = 1;
      }
      return {
        type: 'findOneAndDelete',
        collection: ast.table,
        filter,
        options: {
          projection: projection as Record<string, 0 | 1>,
        },
      };
    }

    return {
      type: 'deleteMany',
      collection: ast.table,
      filter,
    };
  }

  private buildFilter(
    where: WhereClause[] | undefined,
    ctx?: TenantContext
  ): Record<string, unknown> {
    const filter: Record<string, unknown> = {};

    if (this.injectTenant && ctx) {
      filter[this.tenantColumns.appId] = ctx.appId;
      filter[this.tenantColumns.organizationId] = ctx.organizationId;
    }

    if (where) {
      const orConditions: Record<string, unknown>[] = [];
      let hasOr = false;

      for (const clause of where) {
        const value = this.mapOperatorValue(clause.op, clause.value);

        if (clause.connector === 'OR') {
          hasOr = true;
          orConditions.push({ [clause.column]: value });
        } else {
          if (filter[clause.column] !== undefined) {
            const existing = filter[clause.column];
            if (
              typeof existing === 'object' &&
              existing !== null &&
              typeof value === 'object' &&
              value !== null
            ) {
              filter[clause.column] = {
                ...(existing as Record<string, unknown>),
                ...(value as Record<string, unknown>),
              };
            } else {
              filter[clause.column] = value;
            }
          } else {
            filter[clause.column] = value;
          }
        }
      }

      if (hasOr) {
        const andConditions: Record<string, unknown>[] = [];
        for (const [key, val] of Object.entries(filter)) {
          if (key !== '$or') {
            andConditions.push({ [key]: val });
          }
        }
        if (orConditions.length > 0) {
          if (andConditions.length > 0) {
            return {
              $and: [...andConditions, { $or: orConditions }],
            };
          }
          filter.$or = orConditions;
        }
      }
    }

    return filter;
  }

  private mapOperatorValue(op: Operator, value: unknown): unknown {
    switch (op) {
      case '=':
        return value;
      case '!=':
        return { $ne: value };
      case '>':
        return { $gt: value };
      case '<':
        return { $lt: value };
      case '>=':
        return { $gte: value };
      case '<=':
        return { $lte: value };
      case 'IN':
        return { $in: value };
      case 'NOT IN':
        return { $nin: value };
      case 'LIKE':
        return { $regex: this.likeToRegex(value as string) };
      case 'ILIKE':
        return { $regex: this.likeToRegex(value as string), $options: 'i' };
      case 'IS NULL':
        return null;
      case 'IS NOT NULL':
        return { $ne: null };
      default:
        throw new Error(`Unsupported operator: ${op}`);
    }
  }

  private likeToRegex(pattern: string): string {
    return pattern
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\\%/g, '%')
      .replace(/%/g, '.*')
      .replace(/\\_/g, '_')
      .replace(/_/g, '.');
  }

  private injectTenantData(
    data: Record<string, unknown>,
    ctx?: TenantContext
  ): Record<string, unknown> {
    if (!this.injectTenant || !ctx) return data;
    return {
      ...data,
      [this.tenantColumns.appId]: ctx.appId,
      [this.tenantColumns.organizationId]: ctx.organizationId,
    };
  }
}

export function createMongoCompiler(options?: MongoCompilerOptions): MongoCompiler {
  return new MongoCompiler(options);
}
