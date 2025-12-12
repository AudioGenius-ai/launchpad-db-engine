import type { DbClient, TransactionContext } from '../client.js';
import type { Operator, TenantContext } from '../types/index.js';
import type { EntityConstructor } from './metadata.js';
import { getEntityColumns, getEntityTableName } from './schema-extractor.js';

export type WhereCondition<T> = Partial<T> | [keyof T, Operator, unknown][];

export interface FindOptions<T> {
  where?: WhereCondition<T>;
  orderBy?: { [K in keyof T]?: 'asc' | 'desc' };
  limit?: number;
  offset?: number;
  select?: (keyof T)[];
}

export interface FindOneOptions<T> {
  where?: WhereCondition<T>;
  select?: (keyof T)[];
}

export class Repository<T> {
  private db: DbClient | TransactionContext;
  private tenantContext?: TenantContext;
  private tableName: string;
  private columnMap: Map<string, string>;

  constructor(
    entity: EntityConstructor<T>,
    db: DbClient | TransactionContext,
    tenantContext?: TenantContext
  ) {
    this.db = db;
    this.tenantContext = tenantContext;
    this.tableName = getEntityTableName(entity);
    this.columnMap = getEntityColumns(entity);
  }

  async find(options: FindOptions<T> = {}): Promise<T[]> {
    const builder = this.createTableBuilder();

    let selectBuilder = builder.select(
      ...(options.select ? options.select.map((p) => this.toColumn(p as string)) : ['*'])
    );

    if (options.where) {
      selectBuilder = this.applyWhere(selectBuilder, options.where);
    }

    if (options.orderBy) {
      for (const [property, direction] of Object.entries(options.orderBy)) {
        selectBuilder = selectBuilder.orderBy(this.toColumn(property), direction as 'asc' | 'desc');
      }
    }

    if (options.limit !== undefined) {
      selectBuilder = selectBuilder.limit(options.limit);
    }

    if (options.offset !== undefined) {
      selectBuilder = selectBuilder.offset(options.offset);
    }

    const rows = await selectBuilder.execute();
    return rows.map((row: Record<string, unknown>) => this.rowToEntity(row));
  }

  async findOne(options: FindOneOptions<T> = {}): Promise<T | null> {
    const results = await this.find({ ...options, limit: 1 });
    return results[0] || null;
  }

  async findById(id: string | number): Promise<T | null> {
    return this.findOne({ where: { id } as unknown as WhereCondition<T> });
  }

  async create(data: Partial<T>): Promise<T> {
    const builder = this.createTableBuilder();
    const columnData = this.entityToRow(data);

    const rows = await builder.insert().values(columnData).returning('*').execute();

    if (rows.length === 0) {
      throw new Error('Insert did not return any rows');
    }

    return this.rowToEntity(rows[0] as Record<string, unknown>);
  }

  async createMany(data: Partial<T>[]): Promise<T[]> {
    const results: T[] = [];
    for (const item of data) {
      const created = await this.create(item);
      results.push(created);
    }
    return results;
  }

  async update(where: WhereCondition<T>, data: Partial<T>): Promise<T[]> {
    const builder = this.createTableBuilder();
    const columnData = this.entityToRow(data);

    let updateBuilder = builder.update().set(columnData);
    updateBuilder = this.applyWhereToUpdate(updateBuilder, where);

    const rows = await updateBuilder.returning('*').execute();
    return rows.map((row: Record<string, unknown>) => this.rowToEntity(row));
  }

  async updateById(id: string | number, data: Partial<T>): Promise<T | null> {
    const results = await this.update({ id } as unknown as WhereCondition<T>, data);
    return results[0] || null;
  }

  async delete(where: WhereCondition<T>): Promise<number> {
    const builder = this.createTableBuilder();
    let deleteBuilder = builder.delete();
    deleteBuilder = this.applyWhereToDelete(deleteBuilder, where);

    const rows = await deleteBuilder.execute();
    return rows.length;
  }

  async deleteById(id: string | number): Promise<boolean> {
    const count = await this.delete({ id } as unknown as WhereCondition<T>);
    return count > 0;
  }

  async count(where?: WhereCondition<T>): Promise<number> {
    const builder = this.createTableBuilder();
    const selectBuilder = builder.select();

    if (where) {
      this.applyWhere(selectBuilder, where);
    }

    const countResult = await selectBuilder.count();
    return countResult;
  }

  async exists(where: WhereCondition<T>): Promise<boolean> {
    const count = await this.count(where);
    return count > 0;
  }

  private createTableBuilder() {
    if ('table' in this.db && this.tenantContext) {
      return (this.db as DbClient).table(this.tableName, this.tenantContext);
    }
    return (this.db as TransactionContext).table(this.tableName);
  }

  private toColumn(propertyName: string): string {
    return this.columnMap.get(propertyName) || propertyName;
  }

  private applyWhere<B extends { where: (col: string, op: Operator, val: unknown) => B }>(
    builder: B,
    where: WhereCondition<T>
  ): B {
    if (Array.isArray(where)) {
      for (const [property, op, value] of where) {
        builder = builder.where(this.toColumn(property as string), op, value);
      }
    } else {
      for (const [property, value] of Object.entries(where)) {
        if (value !== undefined) {
          builder = builder.where(this.toColumn(property), '=', value);
        }
      }
    }
    return builder;
  }

  private applyWhereToUpdate<
    B extends { where: (col: string, op: Operator, val: unknown) => B },
  >(builder: B, where: WhereCondition<T>): B {
    return this.applyWhere(builder, where);
  }

  private applyWhereToDelete<
    B extends { where: (col: string, op: Operator, val: unknown) => B },
  >(builder: B, where: WhereCondition<T>): B {
    return this.applyWhere(builder, where);
  }

  private entityToRow(entity: Partial<T>): Record<string, unknown> {
    const row: Record<string, unknown> = {};
    for (const [property, value] of Object.entries(entity)) {
      if (value !== undefined) {
        const columnName = this.toColumn(property);
        row[columnName] = value;
      }
    }
    return row;
  }

  private rowToEntity(row: Record<string, unknown>): T {
    const entity: Record<string, unknown> = {};
    for (const [property, columnName] of this.columnMap) {
      if (columnName in row) {
        entity[property] = row[columnName];
      }
    }
    for (const [key, value] of Object.entries(row)) {
      if (!(key in entity)) {
        entity[key] = value;
      }
    }
    return entity as T;
  }
}

export function createRepository<T>(
  entity: EntityConstructor<T>,
  db: DbClient | TransactionContext,
  tenantContext?: TenantContext
): Repository<T> {
  return new Repository(entity, db, tenantContext);
}
