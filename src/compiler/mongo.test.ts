import { describe, expect, it } from 'vitest';
import type { QueryAST, TenantContext } from '../types/index.js';
import { MongoCompiler } from './mongo.js';

describe('MongoCompiler', () => {
  const tenantCtx: TenantContext = {
    appId: 'app-123',
    organizationId: 'org-456',
  };

  describe('compile', () => {
    it('should throw if tenant injection enabled but no context provided', () => {
      const compiler = new MongoCompiler({ injectTenant: true });
      const ast: QueryAST = { type: 'select', table: 'users' };

      expect(() => compiler.compile(ast)).toThrow(
        'Tenant context is required when tenant injection is enabled'
      );
    });

    it('should compile without tenant injection when disabled', () => {
      const compiler = new MongoCompiler({ injectTenant: false });
      const ast: QueryAST = { type: 'select', table: 'users' };

      const op = compiler.compile(ast);

      expect(op.type).toBe('find');
      expect(op.collection).toBe('users');
      expect(op.filter).toEqual({});
    });
  });

  describe('compileSelect (find)', () => {
    const compiler = new MongoCompiler({ injectTenant: true });

    it('should compile basic select to find operation', () => {
      const ast: QueryAST = { type: 'select', table: 'users' };
      const op = compiler.compile(ast, tenantCtx);

      expect(op.type).toBe('find');
      expect(op.collection).toBe('users');
      expect(op.filter).toEqual({
        app_id: 'app-123',
        organization_id: 'org-456',
      });
    });

    it('should add projection for specific columns', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        columns: ['id', 'name', 'email'],
      };
      const op = compiler.compile(ast, tenantCtx);

      expect(op.type).toBe('find');
      expect(op.options?.projection).toEqual({ id: 1, name: 1, email: 1 });
    });

    it('should handle WHERE = operator', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        where: [{ column: 'status', op: '=', value: 'active' }],
      };
      const op = compiler.compile(ast, tenantCtx);

      expect(op.filter).toEqual({
        app_id: 'app-123',
        organization_id: 'org-456',
        status: 'active',
      });
    });

    it('should handle WHERE != operator', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        where: [{ column: 'status', op: '!=', value: 'deleted' }],
      };
      const op = compiler.compile(ast, tenantCtx);

      expect(op.filter?.status).toEqual({ $ne: 'deleted' });
    });

    it('should handle WHERE > operator', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        where: [{ column: 'age', op: '>', value: 18 }],
      };
      const op = compiler.compile(ast, tenantCtx);

      expect(op.filter?.age).toEqual({ $gt: 18 });
    });

    it('should handle WHERE < operator', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        where: [{ column: 'age', op: '<', value: 65 }],
      };
      const op = compiler.compile(ast, tenantCtx);

      expect(op.filter?.age).toEqual({ $lt: 65 });
    });

    it('should handle WHERE >= operator', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        where: [{ column: 'age', op: '>=', value: 18 }],
      };
      const op = compiler.compile(ast, tenantCtx);

      expect(op.filter?.age).toEqual({ $gte: 18 });
    });

    it('should handle WHERE <= operator', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        where: [{ column: 'age', op: '<=', value: 65 }],
      };
      const op = compiler.compile(ast, tenantCtx);

      expect(op.filter?.age).toEqual({ $lte: 65 });
    });

    it('should handle WHERE IN operator', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        where: [{ column: 'status', op: 'IN', value: ['active', 'pending'] }],
      };
      const op = compiler.compile(ast, tenantCtx);

      expect(op.filter?.status).toEqual({ $in: ['active', 'pending'] });
    });

    it('should handle WHERE NOT IN operator', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        where: [{ column: 'status', op: 'NOT IN', value: ['deleted', 'banned'] }],
      };
      const op = compiler.compile(ast, tenantCtx);

      expect(op.filter?.status).toEqual({ $nin: ['deleted', 'banned'] });
    });

    it('should handle WHERE LIKE operator', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        where: [{ column: 'name', op: 'LIKE', value: '%john%' }],
      };
      const op = compiler.compile(ast, tenantCtx);

      expect(op.filter?.name).toEqual({ $regex: '.*john.*' });
    });

    it('should handle WHERE ILIKE operator (case insensitive)', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        where: [{ column: 'name', op: 'ILIKE', value: '%john%' }],
      };
      const op = compiler.compile(ast, tenantCtx);

      expect(op.filter?.name).toEqual({ $regex: '.*john.*', $options: 'i' });
    });

    it('should handle WHERE IS NULL', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        where: [{ column: 'deleted_at', op: 'IS NULL', value: null }],
      };
      const op = compiler.compile(ast, tenantCtx);

      expect(op.filter?.deleted_at).toBeNull();
    });

    it('should handle WHERE IS NOT NULL', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        where: [{ column: 'verified_at', op: 'IS NOT NULL', value: null }],
      };
      const op = compiler.compile(ast, tenantCtx);

      expect(op.filter?.verified_at).toEqual({ $ne: null });
    });

    it('should handle ORDER BY ascending', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        orderBy: { column: 'name', direction: 'asc' },
      };
      const op = compiler.compile(ast, tenantCtx);

      expect(op.options?.sort).toEqual({ name: 1 });
    });

    it('should handle ORDER BY descending', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        orderBy: { column: 'created_at', direction: 'desc' },
      };
      const op = compiler.compile(ast, tenantCtx);

      expect(op.options?.sort).toEqual({ created_at: -1 });
    });

    it('should handle LIMIT', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        limit: 10,
      };
      const op = compiler.compile(ast, tenantCtx);

      expect(op.options?.limit).toBe(10);
    });

    it('should handle OFFSET', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        offset: 20,
      };
      const op = compiler.compile(ast, tenantCtx);

      expect(op.options?.skip).toBe(20);
    });

    it('should handle COUNT(*) with countDocuments', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        columns: ['COUNT(*) as count'],
      };
      const op = compiler.compile(ast, tenantCtx);

      expect(op.type).toBe('countDocuments');
    });
  });

  describe('compileSelect (aggregate)', () => {
    const compiler = new MongoCompiler({ injectTenant: true });

    it('should use aggregate for JOIN queries', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'orders',
        joins: [
          {
            type: 'LEFT',
            table: 'users',
            on: { leftColumn: 'orders.user_id', rightColumn: 'users.id' },
          },
        ],
      };
      const op = compiler.compile(ast, tenantCtx);

      expect(op.type).toBe('aggregate');
      expect(op.pipeline).toBeDefined();
      expect(op.pipeline?.some((stage) => '$lookup' in stage)).toBe(true);
    });

    it('should use aggregate for GROUP BY queries', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'orders',
        groupBy: { columns: ['status'] },
      };
      const op = compiler.compile(ast, tenantCtx);

      expect(op.type).toBe('aggregate');
      expect(op.pipeline?.some((stage) => '$group' in stage)).toBe(true);
    });

    it('should handle HAVING with aggregate', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'orders',
        groupBy: { columns: ['status'] },
        having: [{ column: 'count', op: '>', value: 10 }],
      };
      const op = compiler.compile(ast, tenantCtx);

      expect(op.type).toBe('aggregate');
      const matchStages = op.pipeline?.filter((stage) => '$match' in stage) ?? [];
      expect(matchStages.length).toBeGreaterThan(1);
    });
  });

  describe('compileInsert', () => {
    const compiler = new MongoCompiler({ injectTenant: true });

    it('should compile insertOne', () => {
      const ast: QueryAST = {
        type: 'insert',
        table: 'users',
        data: { name: 'John', email: 'john@example.com' },
      };
      const op = compiler.compile(ast, tenantCtx);

      expect(op.type).toBe('insertOne');
      expect(op.collection).toBe('users');
      expect(op.document).toEqual({
        name: 'John',
        email: 'john@example.com',
        app_id: 'app-123',
        organization_id: 'org-456',
      });
    });

    it('should compile insertMany', () => {
      const ast: QueryAST = {
        type: 'insert',
        table: 'users',
        dataRows: [
          { name: 'John', email: 'john@example.com' },
          { name: 'Jane', email: 'jane@example.com' },
        ],
      };
      const op = compiler.compile(ast, tenantCtx);

      expect(op.type).toBe('insertMany');
      expect(op.documents).toHaveLength(2);
      expect(op.documents?.[0]).toEqual({
        name: 'John',
        email: 'john@example.com',
        app_id: 'app-123',
        organization_id: 'org-456',
      });
    });
  });

  describe('compileUpdate', () => {
    const compiler = new MongoCompiler({ injectTenant: true });

    it('should compile updateMany without RETURNING', () => {
      const ast: QueryAST = {
        type: 'update',
        table: 'users',
        data: { status: 'active' },
        where: [{ column: 'id', op: '=', value: '123' }],
      };
      const op = compiler.compile(ast, tenantCtx);

      expect(op.type).toBe('updateMany');
      expect(op.collection).toBe('users');
      expect(op.filter).toEqual({
        app_id: 'app-123',
        organization_id: 'org-456',
        id: '123',
      });
      expect(op.update).toEqual({ $set: { status: 'active' } });
    });

    it('should compile findOneAndUpdate with RETURNING', () => {
      const ast: QueryAST = {
        type: 'update',
        table: 'users',
        data: { status: 'active' },
        where: [{ column: 'id', op: '=', value: '123' }],
        returning: ['id', 'status'],
      };
      const op = compiler.compile(ast, tenantCtx);

      expect(op.type).toBe('findOneAndUpdate');
      expect(op.options?.returnDocument).toBe('after');
      expect(op.options?.projection).toEqual({ id: 1, status: 1 });
    });
  });

  describe('compileDelete', () => {
    const compiler = new MongoCompiler({ injectTenant: true });

    it('should compile deleteMany without RETURNING', () => {
      const ast: QueryAST = {
        type: 'delete',
        table: 'users',
        where: [{ column: 'status', op: '=', value: 'inactive' }],
      };
      const op = compiler.compile(ast, tenantCtx);

      expect(op.type).toBe('deleteMany');
      expect(op.collection).toBe('users');
      expect(op.filter).toEqual({
        app_id: 'app-123',
        organization_id: 'org-456',
        status: 'inactive',
      });
    });

    it('should compile findOneAndDelete with RETURNING', () => {
      const ast: QueryAST = {
        type: 'delete',
        table: 'users',
        where: [{ column: 'id', op: '=', value: '123' }],
        returning: ['id', 'name'],
      };
      const op = compiler.compile(ast, tenantCtx);

      expect(op.type).toBe('findOneAndDelete');
      expect(op.options?.projection).toEqual({ id: 1, name: 1 });
    });
  });

  describe('tenant injection', () => {
    it('should not inject tenant data when disabled', () => {
      const compiler = new MongoCompiler({ injectTenant: false });
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        where: [{ column: 'status', op: '=', value: 'active' }],
      };
      const op = compiler.compile(ast);

      expect(op.filter).toEqual({ status: 'active' });
      expect(op.filter?.app_id).toBeUndefined();
      expect(op.filter?.organization_id).toBeUndefined();
    });

    it('should use custom tenant column names', () => {
      const compiler = new MongoCompiler({
        injectTenant: true,
        tenantColumns: {
          appId: 'tenant_id',
          organizationId: 'org',
        },
      });
      const ast: QueryAST = { type: 'select', table: 'users' };
      const op = compiler.compile(ast, tenantCtx);

      expect(op.filter).toEqual({
        tenant_id: 'app-123',
        org: 'org-456',
      });
    });
  });

  describe('LIKE to regex conversion', () => {
    const compiler = new MongoCompiler({ injectTenant: false });

    it('should convert % to .*', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        where: [{ column: 'name', op: 'LIKE', value: '%test%' }],
      };
      const op = compiler.compile(ast);

      expect(op.filter?.name).toEqual({ $regex: '.*test.*' });
    });

    it('should convert _ to .', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        where: [{ column: 'code', op: 'LIKE', value: 'A_B_C' }],
      };
      const op = compiler.compile(ast);

      expect(op.filter?.code).toEqual({ $regex: 'A.B.C' });
    });

    it('should escape regex special characters', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        where: [{ column: 'name', op: 'LIKE', value: 'test.com' }],
      };
      const op = compiler.compile(ast);

      expect(op.filter?.name).toEqual({ $regex: 'test\\.com' });
    });
  });
});
