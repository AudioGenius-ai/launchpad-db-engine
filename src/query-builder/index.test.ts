import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQLCompiler } from '../compiler/index.js';
import type { Driver, TransactionClient } from '../driver/types.js';
import type { QueryResult, TenantContext } from '../types/index.js';
import {
  DeleteBuilder,
  InsertBuilder,
  SelectBuilder,
  TableBuilder,
  UpdateBuilder,
} from './index.js';

// Mock driver
function createMockDriver(): Driver {
  return {
    dialect: 'postgresql',
    connectionString: 'postgres://test@localhost/test',
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    execute: vi.fn().mockResolvedValue({ rowCount: 0 }),
    transaction: vi.fn(),
    close: vi.fn(),
  };
}

// Mock compiler
function createMockCompiler(): SQLCompiler {
  return {
    dialect: 'postgresql',
    compile: vi.fn().mockReturnValue({ sql: 'SELECT 1', params: [] }),
  } as unknown as SQLCompiler;
}

const mockCtx: TenantContext = {
  appId: 'test-app',
  organizationId: 'org-123',
};

describe('SelectBuilder', () => {
  let driver: Driver;
  let compiler: SQLCompiler;

  beforeEach(() => {
    driver = createMockDriver();
    compiler = createMockCompiler();
  });

  describe('select()', () => {
    it('should set columns in AST', () => {
      const builder = new SelectBuilder<{ id: string; name: string }>(
        driver,
        compiler,
        'users',
        mockCtx
      );
      builder.select('id', 'name');
      const { sql, params } = builder.toSQL();
      expect(compiler.compile).toHaveBeenCalled();
    });

    it('should default to * columns', () => {
      const builder = new SelectBuilder(driver, compiler, 'users', mockCtx);
      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.columns).toEqual(['*']);
    });
  });

  describe('where()', () => {
    it('should add where clause to AST', () => {
      const builder = new SelectBuilder<{ id: string; status: string }>(
        driver,
        compiler,
        'users',
        mockCtx
      );
      builder.where('status', '=', 'active');
      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.where).toEqual([{ column: 'status', op: '=', value: 'active' }]);
    });

    it('should support multiple where clauses', () => {
      const builder = new SelectBuilder<{ id: string; status: string; role: string }>(
        driver,
        compiler,
        'users',
        mockCtx
      );
      builder.where('status', '=', 'active').where('role', '=', 'admin');
      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.where).toHaveLength(2);
    });
  });

  describe('whereNull()', () => {
    it('should add IS NULL where clause', () => {
      const builder = new SelectBuilder<{ id: string; deleted_at: string | null }>(
        driver,
        compiler,
        'users',
        mockCtx
      );
      builder.whereNull('deleted_at');
      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.where).toEqual([{ column: 'deleted_at', op: 'IS NULL', value: null }]);
    });
  });

  describe('whereNotNull()', () => {
    it('should add IS NOT NULL where clause', () => {
      const builder = new SelectBuilder<{ id: string; email: string | null }>(
        driver,
        compiler,
        'users',
        mockCtx
      );
      builder.whereNotNull('email');
      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.where).toEqual([{ column: 'email', op: 'IS NOT NULL', value: null }]);
    });
  });

  describe('whereIn()', () => {
    it('should add IN where clause with array value', () => {
      const builder = new SelectBuilder<{ id: string; status: string }>(
        driver,
        compiler,
        'users',
        mockCtx
      );
      builder.whereIn('status', ['active', 'pending']);
      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.where).toEqual([{ column: 'status', op: 'IN', value: ['active', 'pending'] }]);
    });
  });

  describe('whereNotIn()', () => {
    it('should add NOT IN where clause with array value', () => {
      const builder = new SelectBuilder<{ id: string; status: string }>(
        driver,
        compiler,
        'users',
        mockCtx
      );
      builder.whereNotIn('status', ['deleted', 'banned']);
      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.where).toEqual([
        { column: 'status', op: 'NOT IN', value: ['deleted', 'banned'] },
      ]);
    });
  });

  describe('whereLike()', () => {
    it('should add LIKE where clause with pattern', () => {
      const builder = new SelectBuilder<{ id: string; name: string }>(
        driver,
        compiler,
        'users',
        mockCtx
      );
      builder.whereLike('name', '%John%');
      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.where).toEqual([{ column: 'name', op: 'LIKE', value: '%John%' }]);
    });
  });

  describe('whereILike()', () => {
    it('should add ILIKE where clause with pattern', () => {
      const builder = new SelectBuilder<{ id: string; email: string }>(
        driver,
        compiler,
        'users',
        mockCtx
      );
      builder.whereILike('email', '%@EXAMPLE.COM');
      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.where).toEqual([{ column: 'email', op: 'ILIKE', value: '%@EXAMPLE.COM' }]);
    });
  });

  describe('orWhere()', () => {
    it('should add OR where clause', () => {
      const builder = new SelectBuilder<{ id: string; status: string; role: string }>(
        driver,
        compiler,
        'users',
        mockCtx
      );
      builder.where('status', '=', 'active').orWhere('role', '=', 'admin');
      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.where).toEqual([
        { column: 'status', op: '=', value: 'active' },
        { column: 'role', op: '=', value: 'admin', connector: 'OR' },
      ]);
    });
  });

  describe('groupBy()', () => {
    it('should set groupBy in AST', () => {
      const builder = new SelectBuilder<{ id: string; status: string; count: number }>(
        driver,
        compiler,
        'users',
        mockCtx
      );
      builder.groupBy('status');
      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.groupBy).toEqual({ columns: ['status'] });
    });

    it('should support multiple groupBy columns', () => {
      const builder = new SelectBuilder<{ id: string; status: string; role: string }>(
        driver,
        compiler,
        'users',
        mockCtx
      );
      builder.groupBy('status', 'role');
      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.groupBy).toEqual({ columns: ['status', 'role'] });
    });
  });

  describe('having()', () => {
    it('should add having clause to AST', () => {
      const builder = new SelectBuilder<{ status: string; count: number }>(
        driver,
        compiler,
        'users',
        mockCtx
      );
      builder.groupBy('status').having('count', '>', 5);
      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.having).toEqual([{ column: 'count', op: '>', value: 5 }]);
    });
  });

  describe('orderBy()', () => {
    it('should set orderBy in AST with default asc', () => {
      const builder = new SelectBuilder<{ id: string; created_at: Date }>(
        driver,
        compiler,
        'users',
        mockCtx
      );
      builder.orderBy('created_at');
      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.orderBy).toEqual({ column: 'created_at', direction: 'asc' });
    });

    it('should set orderBy with desc direction', () => {
      const builder = new SelectBuilder<{ id: string; created_at: Date }>(
        driver,
        compiler,
        'users',
        mockCtx
      );
      builder.orderBy('created_at', 'desc');
      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.orderBy).toEqual({ column: 'created_at', direction: 'desc' });
    });
  });

  describe('limit()', () => {
    it('should set limit in AST', () => {
      const builder = new SelectBuilder(driver, compiler, 'users', mockCtx);
      builder.limit(10);
      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.limit).toBe(10);
    });
  });

  describe('offset()', () => {
    it('should set offset in AST', () => {
      const builder = new SelectBuilder(driver, compiler, 'users', mockCtx);
      builder.offset(20);
      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.offset).toBe(20);
    });
  });

  describe('join()', () => {
    it('should add INNER join to AST', () => {
      const builder = new SelectBuilder(driver, compiler, 'orders', mockCtx);
      builder.join('INNER', 'users', 'orders.user_id', 'users.id');
      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.joins).toEqual([
        {
          type: 'INNER',
          table: 'users',
          alias: undefined,
          on: { leftColumn: 'orders.user_id', rightColumn: 'users.id' },
        },
      ]);
    });

    it('should add LEFT join with alias', () => {
      const builder = new SelectBuilder(driver, compiler, 'orders', mockCtx);
      builder.leftJoin('users', 'orders.user_id', 'users.id', 'u');
      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.joins[0].alias).toBe('u');
      expect(callArg.joins[0].type).toBe('LEFT');
    });
  });

  describe('innerJoin()', () => {
    it('should be shorthand for INNER join', () => {
      const builder = new SelectBuilder(driver, compiler, 'orders', mockCtx);
      builder.innerJoin('users', 'orders.user_id', 'users.id');
      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.joins[0].type).toBe('INNER');
    });
  });

  describe('execute()', () => {
    it('should call driver.query with compiled SQL', async () => {
      (compiler.compile as ReturnType<typeof vi.fn>).mockReturnValue({
        sql: 'SELECT * FROM users',
        params: ['test-app', 'org-123'],
      });
      (driver.query as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [{ id: '1', name: 'Test' }],
        rowCount: 1,
      });

      const builder = new SelectBuilder(driver, compiler, 'users', mockCtx);
      const result = await builder.execute();

      expect(driver.query).toHaveBeenCalledWith('SELECT * FROM users', ['test-app', 'org-123']);
      expect(result).toEqual([{ id: '1', name: 'Test' }]);
    });
  });

  describe('first()', () => {
    it('should return first row or null', async () => {
      (driver.query as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [{ id: '1' }],
        rowCount: 1,
      });

      const builder = new SelectBuilder(driver, compiler, 'users', mockCtx);
      const result = await builder.first();

      expect(result).toEqual({ id: '1' });
    });

    it('should return null when no rows', async () => {
      (driver.query as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [],
        rowCount: 0,
      });

      const builder = new SelectBuilder(driver, compiler, 'users', mockCtx);
      const result = await builder.first();

      expect(result).toBeNull();
    });
  });

  describe('count()', () => {
    it('should return count as number', async () => {
      (driver.query as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [{ count: '42' }],
        rowCount: 1,
      });

      const builder = new SelectBuilder(driver, compiler, 'users', mockCtx);
      const result = await builder.count();

      expect(result).toBe(42);
    });
  });

  describe('fluent chaining', () => {
    it('should support full fluent chain', () => {
      const builder = new SelectBuilder<{
        id: string;
        name: string;
        status: string;
        created_at: Date;
      }>(driver, compiler, 'users', mockCtx);

      builder
        .select('id', 'name')
        .where('status', '=', 'active')
        .orderBy('created_at', 'desc')
        .limit(10)
        .offset(0);

      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];

      expect(callArg.columns).toEqual(['id', 'name']);
      expect(callArg.where).toHaveLength(1);
      expect(callArg.orderBy).toEqual({ column: 'created_at', direction: 'desc' });
      expect(callArg.limit).toBe(10);
      expect(callArg.offset).toBe(0);
    });
  });
});

describe('InsertBuilder', () => {
  let driver: Driver;
  let compiler: SQLCompiler;

  beforeEach(() => {
    driver = createMockDriver();
    compiler = createMockCompiler();
  });

  describe('values()', () => {
    it('should set data in AST', () => {
      const builder = new InsertBuilder<{ id: string; name: string; email: string }>(
        driver,
        compiler,
        'users',
        mockCtx
      );
      builder.values({ name: 'Test', email: 'test@example.com' });
      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.data).toEqual({ name: 'Test', email: 'test@example.com' });
    });
  });

  describe('valuesMany()', () => {
    it('should set dataRows in AST for bulk insert', () => {
      const builder = new InsertBuilder<{ id: string; name: string; email: string }>(
        driver,
        compiler,
        'users',
        mockCtx
      );
      builder.valuesMany([
        { name: 'User 1', email: 'user1@example.com' },
        { name: 'User 2', email: 'user2@example.com' },
      ]);
      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.dataRows).toEqual([
        { name: 'User 1', email: 'user1@example.com' },
        { name: 'User 2', email: 'user2@example.com' },
      ]);
    });
  });

  describe('onConflict()', () => {
    it('should set onConflict with update action', () => {
      const builder = new InsertBuilder<{ id: string; name: string; email: string }>(
        driver,
        compiler,
        'users',
        mockCtx
      );
      builder.values({ name: 'Test', email: 'test@example.com' }).onConflict(['email'], 'update');
      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.onConflict).toEqual({
        columns: ['email'],
        action: 'update',
        updateColumns: undefined,
      });
    });

    it('should set onConflict with nothing action', () => {
      const builder = new InsertBuilder<{ id: string; name: string; email: string }>(
        driver,
        compiler,
        'users',
        mockCtx
      );
      builder.values({ name: 'Test', email: 'test@example.com' }).onConflict(['email'], 'nothing');
      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.onConflict).toEqual({
        columns: ['email'],
        action: 'nothing',
        updateColumns: undefined,
      });
    });

    it('should set onConflict with specific update columns', () => {
      const builder = new InsertBuilder<{ id: string; name: string; email: string }>(
        driver,
        compiler,
        'users',
        mockCtx
      );
      builder
        .values({ name: 'Test', email: 'test@example.com' })
        .onConflict(['email'], 'update', ['name']);
      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.onConflict).toEqual({
        columns: ['email'],
        action: 'update',
        updateColumns: ['name'],
      });
    });
  });

  describe('returning()', () => {
    it('should set returning columns in AST', () => {
      const builder = new InsertBuilder<{ id: string; name: string }>(
        driver,
        compiler,
        'users',
        mockCtx
      );
      builder.values({ name: 'Test' }).returning('id');
      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.returning).toEqual(['id']);
    });
  });

  describe('execute()', () => {
    it('should call driver.query when returning is set', async () => {
      (compiler.compile as ReturnType<typeof vi.fn>).mockReturnValue({
        sql: 'INSERT INTO users (name) VALUES ($1) RETURNING id',
        params: ['Test'],
      });
      (driver.query as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [{ id: '123' }],
        rowCount: 1,
      });

      const builder = new InsertBuilder<{ id: string; name: string }>(
        driver,
        compiler,
        'users',
        mockCtx
      );
      const result = await builder.values({ name: 'Test' }).returning('id').execute();

      expect(driver.query).toHaveBeenCalled();
      expect(result).toEqual([{ id: '123' }]);
    });

    it('should call driver.execute when no returning', async () => {
      const builder = new InsertBuilder(driver, compiler, 'users', mockCtx);
      await builder.values({ name: 'Test' }).execute();

      expect(driver.execute).toHaveBeenCalled();
    });
  });
});

describe('UpdateBuilder', () => {
  let driver: Driver;
  let compiler: SQLCompiler;

  beforeEach(() => {
    driver = createMockDriver();
    compiler = createMockCompiler();
  });

  describe('set()', () => {
    it('should set data in AST', () => {
      const builder = new UpdateBuilder<{ id: string; name: string; status: string }>(
        driver,
        compiler,
        'users',
        mockCtx
      );
      builder.set({ name: 'Updated', status: 'inactive' });
      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.data).toEqual({ name: 'Updated', status: 'inactive' });
    });
  });

  describe('where()', () => {
    it('should add where clause', () => {
      const builder = new UpdateBuilder<{ id: string; name: string }>(
        driver,
        compiler,
        'users',
        mockCtx
      );
      builder.set({ name: 'Updated' }).where('id', '=', '123');
      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.where).toEqual([{ column: 'id', op: '=', value: '123' }]);
    });
  });

  describe('returning()', () => {
    it('should set returning columns', () => {
      const builder = new UpdateBuilder<{ id: string; name: string; updated_at: Date }>(
        driver,
        compiler,
        'users',
        mockCtx
      );
      builder.set({ name: 'Updated' }).returning('id', 'updated_at');
      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.returning).toEqual(['id', 'updated_at']);
    });
  });

  describe('execute()', () => {
    it('should call driver.query when returning is set', async () => {
      (driver.query as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [{ id: '123', name: 'Updated' }],
        rowCount: 1,
      });

      const builder = new UpdateBuilder<{ id: string; name: string }>(
        driver,
        compiler,
        'users',
        mockCtx
      );
      builder.set({ name: 'Updated' }).where('id', '=', '123').returning('id', 'name');
      const result = await builder.execute();

      expect(driver.query).toHaveBeenCalled();
      expect(result).toEqual([{ id: '123', name: 'Updated' }]);
    });
  });
});

describe('DeleteBuilder', () => {
  let driver: Driver;
  let compiler: SQLCompiler;

  beforeEach(() => {
    driver = createMockDriver();
    compiler = createMockCompiler();
  });

  describe('where()', () => {
    it('should add where clause', () => {
      const builder = new DeleteBuilder<{ id: string }>(driver, compiler, 'users', mockCtx);
      builder.where('id', '=', '123');
      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.where).toEqual([{ column: 'id', op: '=', value: '123' }]);
    });
  });

  describe('returning()', () => {
    it('should set returning columns', () => {
      const builder = new DeleteBuilder<{ id: string; name: string }>(
        driver,
        compiler,
        'users',
        mockCtx
      );
      builder.where('id', '=', '123').returning('id', 'name');
      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.returning).toEqual(['id', 'name']);
    });
  });

  describe('execute()', () => {
    it('should call driver.execute when no returning', async () => {
      const builder = new DeleteBuilder(driver, compiler, 'users', mockCtx);
      await builder.where('id', '=', '123').execute();

      expect(driver.execute).toHaveBeenCalled();
    });
  });
});

describe('TableBuilder', () => {
  let driver: Driver;
  let compiler: SQLCompiler;

  beforeEach(() => {
    driver = createMockDriver();
    compiler = createMockCompiler();
  });

  describe('select()', () => {
    it('should return SelectBuilder', () => {
      const table = new TableBuilder(driver, compiler, 'users', mockCtx);
      const builder = table.select();
      expect(builder).toBeInstanceOf(SelectBuilder);
    });

    it('should pass columns to SelectBuilder', () => {
      const table = new TableBuilder<{ id: string; name: string }>(
        driver,
        compiler,
        'users',
        mockCtx
      );
      const builder = table.select('id', 'name');
      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.columns).toEqual(['id', 'name']);
    });
  });

  describe('insert()', () => {
    it('should return InsertBuilder', () => {
      const table = new TableBuilder(driver, compiler, 'users', mockCtx);
      const builder = table.insert();
      expect(builder).toBeInstanceOf(InsertBuilder);
    });
  });

  describe('update()', () => {
    it('should return UpdateBuilder', () => {
      const table = new TableBuilder(driver, compiler, 'users', mockCtx);
      const builder = table.update();
      expect(builder).toBeInstanceOf(UpdateBuilder);
    });
  });

  describe('delete()', () => {
    it('should return DeleteBuilder', () => {
      const table = new TableBuilder(driver, compiler, 'users', mockCtx);
      const builder = table.delete();
      expect(builder).toBeInstanceOf(DeleteBuilder);
    });
  });

  describe('findById()', () => {
    it('should query by id', async () => {
      (driver.query as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [{ id: '123', name: 'Test' }],
        rowCount: 1,
      });

      const table = new TableBuilder<{ id: string; name: string }>(
        driver,
        compiler,
        'users',
        mockCtx
      );
      const result = await table.findById('123');

      expect(result).toEqual({ id: '123', name: 'Test' });
    });

    it('should return null when not found', async () => {
      (driver.query as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [],
        rowCount: 0,
      });

      const table = new TableBuilder(driver, compiler, 'users', mockCtx);
      const result = await table.findById('999');

      expect(result).toBeNull();
    });
  });

  describe('findMany()', () => {
    it('should query with options', async () => {
      (driver.query as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [
          { id: '1', status: 'active' },
          { id: '2', status: 'active' },
        ],
        rowCount: 2,
      });

      const table = new TableBuilder<{ id: string; status: string; created_at: Date }>(
        driver,
        compiler,
        'users',
        mockCtx
      );
      const result = await table.findMany({
        where: [{ column: 'status', op: '=', value: 'active' }],
        orderBy: { column: 'created_at', direction: 'desc' },
        limit: 10,
        offset: 0,
      });

      expect(result).toHaveLength(2);
    });

    it('should work without options', async () => {
      (driver.query as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [],
        rowCount: 0,
      });

      const table = new TableBuilder(driver, compiler, 'users', mockCtx);
      const result = await table.findMany();

      expect(result).toEqual([]);
    });
  });
});
