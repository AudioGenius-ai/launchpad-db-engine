import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQLCompiler } from '../compiler/index.js';
import type { Driver } from '../driver/types.js';
import type { TenantContext } from '../types/index.js';
import { DeleteBuilder, InsertBuilder, SelectBuilder, UpdateBuilder } from './index.js';

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

describe('Query Builder Edge Cases', () => {
  let driver: Driver;
  let compiler: SQLCompiler;

  beforeEach(() => {
    driver = createMockDriver();
    compiler = createMockCompiler();
  });

  describe('Complex Nested WHERE Conditions', () => {
    it('should handle (A AND B) OR C pattern', () => {
      const builder = new SelectBuilder<{
        id: string;
        status: string;
        role: string;
        verified: boolean;
      }>(driver, compiler, 'users', mockCtx);

      builder
        .where('status', '=', 'active')
        .where('role', '=', 'admin')
        .orWhere('verified', '=', true);

      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];

      expect(callArg.where).toHaveLength(3);
      expect(callArg.where[0]).toEqual({ column: 'status', op: '=', value: 'active' });
      expect(callArg.where[1]).toEqual({ column: 'role', op: '=', value: 'admin' });
      expect(callArg.where[2]).toEqual({
        column: 'verified',
        op: '=',
        value: true,
        connector: 'OR',
      });
    });

    it('should handle multiple OR conditions', () => {
      const builder = new SelectBuilder<{ id: string; status: string }>(
        driver,
        compiler,
        'users',
        mockCtx
      );

      builder
        .where('status', '=', 'active')
        .orWhere('status', '=', 'pending')
        .orWhere('status', '=', 'review');

      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];

      expect(callArg.where).toHaveLength(3);
      expect(callArg.where[1].connector).toBe('OR');
      expect(callArg.where[2].connector).toBe('OR');
    });

    it('should handle 10+ WHERE conditions', () => {
      const builder = new SelectBuilder<{ id: string; field: string }>(
        driver,
        compiler,
        'users',
        mockCtx
      );

      for (let i = 0; i < 12; i++) {
        builder.where('field', '=', `value${i}`);
      }

      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];

      expect(callArg.where).toHaveLength(12);
    });

    it('should handle mixed operators in WHERE chain', () => {
      const builder = new SelectBuilder<{
        id: string;
        status: string;
        age: number;
        name: string;
        deleted_at: string | null;
      }>(driver, compiler, 'users', mockCtx);

      builder
        .where('status', '=', 'active')
        .where('age', '>', 18)
        .where('age', '<', 65)
        .whereLike('name', '%John%')
        .whereNull('deleted_at');

      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];

      expect(callArg.where).toHaveLength(5);
      expect(callArg.where.map((w: { op: string }) => w.op)).toEqual([
        '=',
        '>',
        '<',
        'LIKE',
        'IS NULL',
      ]);
    });

    it('should handle alternating AND/OR pattern', () => {
      const builder = new SelectBuilder<{ id: string; a: string; b: string; c: string; d: string }>(
        driver,
        compiler,
        'users',
        mockCtx
      );

      builder
        .where('a', '=', '1')
        .orWhere('b', '=', '2')
        .where('c', '=', '3')
        .orWhere('d', '=', '4');

      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];

      expect(callArg.where).toHaveLength(4);
      expect(callArg.where[0].connector).toBeUndefined();
      expect(callArg.where[1].connector).toBe('OR');
      expect(callArg.where[2].connector).toBeUndefined();
      expect(callArg.where[3].connector).toBe('OR');
    });
  });

  describe('JOIN with Multiple Aliases', () => {
    it('should handle multiple JOINs with different aliases', () => {
      const builder = new SelectBuilder(driver, compiler, 'orders', mockCtx);

      builder
        .leftJoin('users', 'orders.user_id', 'u.id', 'u')
        .leftJoin('products', 'orders.product_id', 'p.id', 'p')
        .leftJoin('categories', 'p.category_id', 'c.id', 'c');

      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];

      expect(callArg.joins).toHaveLength(3);
      expect(callArg.joins[0].alias).toBe('u');
      expect(callArg.joins[1].alias).toBe('p');
      expect(callArg.joins[2].alias).toBe('c');
    });

    it('should handle self-join with aliases', () => {
      const builder = new SelectBuilder(driver, compiler, 'employees', mockCtx);

      builder.leftJoin('employees', 'employees.manager_id', 'manager.id', 'manager');

      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];

      expect(callArg.joins).toHaveLength(1);
      expect(callArg.joins[0].table).toBe('employees');
      expect(callArg.joins[0].alias).toBe('manager');
    });

    it('should handle mixed JOIN types', () => {
      const builder = new SelectBuilder(driver, compiler, 'orders', mockCtx);

      builder
        .innerJoin('users', 'orders.user_id', 'users.id')
        .leftJoin('addresses', 'users.address_id', 'addresses.id')
        .join('RIGHT', 'payments', 'orders.id', 'payments.order_id')
        .join('FULL', 'refunds', 'orders.id', 'refunds.order_id');

      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];

      expect(callArg.joins).toHaveLength(4);
      expect(callArg.joins.map((j: { type: string }) => j.type)).toEqual([
        'INNER',
        'LEFT',
        'RIGHT',
        'FULL',
      ]);
    });

    it('should handle JOIN with aliased column references', () => {
      const builder = new SelectBuilder(driver, compiler, 'orders', mockCtx);

      builder.leftJoin('users', 'orders.user_id', 'u.id', 'u');

      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];

      expect(callArg.joins[0].on.leftColumn).toBe('orders.user_id');
      expect(callArg.joins[0].on.rightColumn).toBe('u.id');
    });

    it('should handle JOIN without alias (undefined)', () => {
      const builder = new SelectBuilder(driver, compiler, 'orders', mockCtx);

      builder.innerJoin('users', 'orders.user_id', 'users.id');

      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];

      expect(callArg.joins[0].alias).toBeUndefined();
    });

    it('should handle chained JOINs (A→B→C pattern)', () => {
      const builder = new SelectBuilder(driver, compiler, 'order_items', mockCtx);

      builder
        .innerJoin('orders', 'order_items.order_id', 'o.id', 'o')
        .innerJoin('users', 'o.user_id', 'u.id', 'u')
        .innerJoin('profiles', 'u.profile_id', 'p.id', 'p');

      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];

      expect(callArg.joins).toHaveLength(3);
      expect(callArg.joins[0].on.rightColumn).toBe('o.id');
      expect(callArg.joins[1].on.leftColumn).toBe('o.user_id');
      expect(callArg.joins[2].on.leftColumn).toBe('u.profile_id');
    });
  });

  describe('GROUP BY + HAVING Edge Cases', () => {
    it('should handle GROUP BY with multiple HAVING conditions', () => {
      const builder = new SelectBuilder<{ status: string; count: number; total: number }>(
        driver,
        compiler,
        'orders',
        mockCtx
      );

      builder.groupBy('status').having('count', '>', 5).having('total', '<', 1000);

      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];

      expect(callArg.having).toHaveLength(2);
      expect(callArg.having[0]).toEqual({ column: 'count', op: '>', value: 5 });
      expect(callArg.having[1]).toEqual({ column: 'total', op: '<', value: 1000 });
    });

    it('should handle multiple GROUP BY columns with HAVING', () => {
      const builder = new SelectBuilder<{
        status: string;
        category: string;
        region: string;
        count: number;
      }>(driver, compiler, 'orders', mockCtx);

      builder.groupBy('status', 'category', 'region').having('count', '>=', 10);

      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];

      expect(callArg.groupBy.columns).toEqual(['status', 'category', 'region']);
      expect(callArg.having).toHaveLength(1);
    });

    it('should handle GROUP BY + HAVING + ORDER BY + LIMIT combination', () => {
      const builder = new SelectBuilder<{ status: string; count: number }>(
        driver,
        compiler,
        'orders',
        mockCtx
      );

      builder
        .groupBy('status')
        .having('count', '>', 0)
        .orderBy('count', 'desc')
        .limit(10)
        .offset(5);

      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];

      expect(callArg.groupBy.columns).toEqual(['status']);
      expect(callArg.having).toHaveLength(1);
      expect(callArg.orderBy).toEqual({ column: 'count', direction: 'desc' });
      expect(callArg.limit).toBe(10);
      expect(callArg.offset).toBe(5);
    });

    it('should handle HAVING with different operators', () => {
      const builder = new SelectBuilder<{ status: string; count: number }>(
        driver,
        compiler,
        'orders',
        mockCtx
      );

      builder
        .groupBy('status')
        .having('count', '=', 100)
        .having('count', '!=', 0)
        .having('count', '>=', 1)
        .having('count', '<=', 1000);

      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];

      expect(callArg.having).toHaveLength(4);
      expect(callArg.having.map((h: { op: string }) => h.op)).toEqual(['=', '!=', '>=', '<=']);
    });

    it('should handle GROUP BY without HAVING', () => {
      const builder = new SelectBuilder<{ status: string }>(driver, compiler, 'orders', mockCtx);

      builder.groupBy('status');

      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];

      expect(callArg.groupBy.columns).toEqual(['status']);
      expect(callArg.having).toBeUndefined();
    });

    it('should handle single column GROUP BY', () => {
      const builder = new SelectBuilder<{ category: string }>(
        driver,
        compiler,
        'products',
        mockCtx
      );

      builder.groupBy('category');

      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];

      expect(callArg.groupBy.columns).toHaveLength(1);
      expect(callArg.groupBy.columns[0]).toBe('category');
    });
  });

  describe('Batch Insert Edge Cases', () => {
    it('should handle valuesMany with single row', () => {
      const builder = new InsertBuilder<{ id: string; name: string }>(
        driver,
        compiler,
        'users',
        mockCtx
      );

      builder.valuesMany([{ name: 'Single User' }]);

      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];

      expect(callArg.dataRows).toHaveLength(1);
      expect(callArg.dataRows[0]).toEqual({ name: 'Single User' });
    });

    it('should handle valuesMany with 100 rows', () => {
      const builder = new InsertBuilder<{ id: string; name: string }>(
        driver,
        compiler,
        'users',
        mockCtx
      );

      const rows = Array.from({ length: 100 }, (_, i) => ({ name: `User ${i}` }));
      builder.valuesMany(rows);

      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];

      expect(callArg.dataRows).toHaveLength(100);
    });

    it('should handle valuesMany with 1000 rows', () => {
      const builder = new InsertBuilder<{ id: string; name: string }>(
        driver,
        compiler,
        'users',
        mockCtx
      );

      const rows = Array.from({ length: 1000 }, (_, i) => ({ name: `User ${i}` }));
      builder.valuesMany(rows);

      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];

      expect(callArg.dataRows).toHaveLength(1000);
    });

    it('should handle valuesMany + onConflict with update action', () => {
      const builder = new InsertBuilder<{ id: string; email: string; name: string }>(
        driver,
        compiler,
        'users',
        mockCtx
      );

      builder
        .valuesMany([
          { email: 'user1@example.com', name: 'User 1' },
          { email: 'user2@example.com', name: 'User 2' },
        ])
        .onConflict(['email'], 'update');

      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];

      expect(callArg.dataRows).toHaveLength(2);
      expect(callArg.onConflict).toEqual({
        columns: ['email'],
        action: 'update',
        updateColumns: undefined,
      });
    });

    it('should handle valuesMany + onConflict with nothing action', () => {
      const builder = new InsertBuilder<{ id: string; email: string }>(
        driver,
        compiler,
        'users',
        mockCtx
      );

      builder
        .valuesMany([{ email: 'user1@example.com' }, { email: 'user2@example.com' }])
        .onConflict(['email'], 'nothing');

      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];

      expect(callArg.onConflict.action).toBe('nothing');
    });

    it('should handle valuesMany + RETURNING', () => {
      const builder = new InsertBuilder<{ id: string; name: string; created_at: Date }>(
        driver,
        compiler,
        'users',
        mockCtx
      );

      builder
        .valuesMany([{ name: 'User 1' }, { name: 'User 2' }])
        .returning('id', 'name', 'created_at');

      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];

      expect(callArg.dataRows).toHaveLength(2);
      expect(callArg.returning).toEqual(['id', 'name', 'created_at']);
    });

    it('should handle rows with null values', () => {
      const builder = new InsertBuilder<{ id: string; name: string; email: string | null }>(
        driver,
        compiler,
        'users',
        mockCtx
      );

      builder.valuesMany([
        { name: 'User 1', email: null },
        { name: 'User 2', email: 'user2@example.com' },
      ]);

      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];

      expect(callArg.dataRows[0].email).toBeNull();
      expect(callArg.dataRows[1].email).toBe('user2@example.com');
    });

    it('should handle onConflict with specific update columns', () => {
      const builder = new InsertBuilder<{
        id: string;
        email: string;
        name: string;
        status: string;
      }>(driver, compiler, 'users', mockCtx);

      builder
        .valuesMany([{ email: 'user@example.com', name: 'User', status: 'active' }])
        .onConflict(['email'], 'update', ['name', 'status']);

      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];

      expect(callArg.onConflict.updateColumns).toEqual(['name', 'status']);
    });

    it('should handle onConflict with multiple conflict columns', () => {
      const builder = new InsertBuilder<{
        id: string;
        app_id: string;
        email: string;
        name: string;
      }>(driver, compiler, 'users', mockCtx);

      builder
        .values({ email: 'user@example.com', name: 'User' })
        .onConflict(['app_id', 'email'], 'update');

      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];

      expect(callArg.onConflict.columns).toEqual(['app_id', 'email']);
    });
  });

  describe('Update Builder Edge Cases', () => {
    it('should handle update with multiple WHERE conditions', () => {
      const builder = new UpdateBuilder<{ id: string; status: string; name: string }>(
        driver,
        compiler,
        'users',
        mockCtx
      );

      builder.set({ status: 'inactive' }).where('id', '=', '123').where('status', '=', 'active');

      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];

      expect(callArg.where).toHaveLength(2);
    });

    it('should handle update with RETURNING multiple columns', () => {
      const builder = new UpdateBuilder<{
        id: string;
        name: string;
        status: string;
        updated_at: Date;
      }>(driver, compiler, 'users', mockCtx);

      builder
        .set({ name: 'Updated' })
        .where('id', '=', '123')
        .returning('id', 'name', 'status', 'updated_at');

      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];

      expect(callArg.returning).toHaveLength(4);
    });
  });

  describe('Delete Builder Edge Cases', () => {
    it('should handle delete with multiple WHERE conditions', () => {
      const builder = new DeleteBuilder<{ id: string; status: string; deleted_at: Date | null }>(
        driver,
        compiler,
        'users',
        mockCtx
      );

      builder.where('status', '=', 'inactive').where('deleted_at', '!=', null);

      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];

      expect(callArg.where).toHaveLength(2);
    });

    it('should handle delete with RETURNING', () => {
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

  describe('Complex Query Combinations', () => {
    it('should handle SELECT with JOIN + WHERE + GROUP BY + HAVING + ORDER BY + LIMIT', () => {
      const builder = new SelectBuilder<{
        status: string;
        category: string;
        count: number;
      }>(driver, compiler, 'orders', mockCtx);

      builder
        .select('status', 'category')
        .innerJoin('products', 'orders.product_id', 'products.id', 'p')
        .where('status', '!=', 'cancelled')
        .groupBy('status', 'category')
        .having('count', '>', 10)
        .orderBy('count', 'desc')
        .limit(20)
        .offset(0);

      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];

      expect(callArg.columns).toEqual(['status', 'category']);
      expect(callArg.joins).toHaveLength(1);
      expect(callArg.where).toHaveLength(1);
      expect(callArg.groupBy.columns).toEqual(['status', 'category']);
      expect(callArg.having).toHaveLength(1);
      expect(callArg.orderBy).toEqual({ column: 'count', direction: 'desc' });
      expect(callArg.limit).toBe(20);
      expect(callArg.offset).toBe(0);
    });

    it('should handle INSERT with valuesMany + onConflict + RETURNING', () => {
      const builder = new InsertBuilder<{ id: string; email: string; name: string }>(
        driver,
        compiler,
        'users',
        mockCtx
      );

      builder
        .valuesMany([
          { email: 'user1@example.com', name: 'User 1' },
          { email: 'user2@example.com', name: 'User 2' },
        ])
        .onConflict(['email'], 'update', ['name'])
        .returning('id', 'email');

      builder.toSQL();
      const callArg = (compiler.compile as ReturnType<typeof vi.fn>).mock.calls[0][0];

      expect(callArg.dataRows).toHaveLength(2);
      expect(callArg.onConflict).toBeDefined();
      expect(callArg.returning).toEqual(['id', 'email']);
    });
  });
});
