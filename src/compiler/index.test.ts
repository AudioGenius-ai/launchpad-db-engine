import { describe, expect, it } from 'vitest';
import type { QueryAST, TenantContext } from '../types/index.js';
import { SQLCompiler, createCompiler } from './index.js';

const mockCtx: TenantContext = {
  appId: 'test-app',
  organizationId: 'org-123',
};

describe('SQLCompiler', () => {
  describe('PostgreSQL dialect', () => {
    const compiler = createCompiler({ dialect: 'postgresql' });

    describe('SELECT queries', () => {
      it('should compile basic SELECT with tenant injection', () => {
        const ast: QueryAST = {
          type: 'select',
          table: 'users',
          columns: ['id', 'name'],
          where: [],
        };

        const { sql, params } = compiler.compile(ast, mockCtx);

        expect(sql).toBe(
          'SELECT id, name FROM "users" WHERE "app_id" = $1 AND "organization_id" = $2'
        );
        expect(params).toEqual(['test-app', 'org-123']);
      });

      it('should compile SELECT with WHERE clause', () => {
        const ast: QueryAST = {
          type: 'select',
          table: 'users',
          columns: ['*'],
          where: [{ column: 'status', op: '=', value: 'active' }],
        };

        const { sql, params } = compiler.compile(ast, mockCtx);

        expect(sql).toBe(
          'SELECT * FROM "users" WHERE "app_id" = $1 AND "organization_id" = $2 AND "status" = $3'
        );
        expect(params).toEqual(['test-app', 'org-123', 'active']);
      });

      it('should compile SELECT with multiple WHERE clauses', () => {
        const ast: QueryAST = {
          type: 'select',
          table: 'users',
          columns: ['*'],
          where: [
            { column: 'status', op: '=', value: 'active' },
            { column: 'role', op: '=', value: 'admin' },
          ],
        };

        const { sql, params } = compiler.compile(ast, mockCtx);

        expect(sql).toContain('"status" = $3 AND "role" = $4');
        expect(params).toEqual(['test-app', 'org-123', 'active', 'admin']);
      });

      it('should compile SELECT with ORDER BY', () => {
        const ast: QueryAST = {
          type: 'select',
          table: 'users',
          columns: ['*'],
          where: [],
          orderBy: { column: 'created_at', direction: 'desc' },
        };

        const { sql } = compiler.compile(ast, mockCtx);

        expect(sql).toContain('ORDER BY "created_at" DESC');
      });

      it('should compile SELECT with LIMIT', () => {
        const ast: QueryAST = {
          type: 'select',
          table: 'users',
          columns: ['*'],
          where: [],
          limit: 10,
        };

        const { sql } = compiler.compile(ast, mockCtx);

        expect(sql).toContain('LIMIT 10');
      });

      it('should compile SELECT with OFFSET', () => {
        const ast: QueryAST = {
          type: 'select',
          table: 'users',
          columns: ['*'],
          where: [],
          offset: 20,
        };

        const { sql } = compiler.compile(ast, mockCtx);

        expect(sql).toContain('OFFSET 20');
      });

      it('should compile SELECT with IS NULL', () => {
        const ast: QueryAST = {
          type: 'select',
          table: 'users',
          columns: ['*'],
          where: [{ column: 'deleted_at', op: 'IS NULL', value: null }],
        };

        const { sql, params } = compiler.compile(ast, mockCtx);

        expect(sql).toContain('"deleted_at" IS NULL');
        expect(params).toEqual(['test-app', 'org-123']); // No value for IS NULL
      });

      it('should compile SELECT with IS NOT NULL', () => {
        const ast: QueryAST = {
          type: 'select',
          table: 'users',
          columns: ['*'],
          where: [{ column: 'email', op: 'IS NOT NULL', value: null }],
        };

        const { sql } = compiler.compile(ast, mockCtx);

        expect(sql).toContain('"email" IS NOT NULL');
      });

      it('should compile SELECT with IN clause', () => {
        const ast: QueryAST = {
          type: 'select',
          table: 'users',
          columns: ['*'],
          where: [{ column: 'status', op: 'IN', value: ['active', 'pending'] }],
        };

        const { sql, params } = compiler.compile(ast, mockCtx);

        expect(sql).toContain('"status" IN ($3, $4)');
        // IN clause values should be spread as individual params
        expect(params[2]).toEqual('active');
        expect(params[3]).toEqual('pending');
        expect(params.length).toBe(4); // 2 tenant params + 2 IN values
      });

      it('should compile SELECT with empty IN clause', () => {
        const ast: QueryAST = {
          type: 'select',
          table: 'users',
          columns: ['*'],
          where: [{ column: 'status', op: 'IN', value: [] }],
        };

        const { sql, params } = compiler.compile(ast, mockCtx);

        // Empty IN should return no rows (1 = 0)
        expect(sql).toContain('1 = 0');
        expect(params.length).toBe(2); // Only tenant params
      });

      it('should compile SELECT with empty NOT IN clause', () => {
        const ast: QueryAST = {
          type: 'select',
          table: 'users',
          columns: ['*'],
          where: [{ column: 'status', op: 'NOT IN', value: [] }],
        };

        const { sql, params } = compiler.compile(ast, mockCtx);

        // Empty NOT IN should return all rows (1 = 1)
        expect(sql).toContain('1 = 1');
        expect(params.length).toBe(2); // Only tenant params
      });

      it('should compile SELECT with JOIN', () => {
        const ast: QueryAST = {
          type: 'select',
          table: 'orders',
          columns: ['*'],
          where: [],
          joins: [
            {
              type: 'INNER',
              table: 'users',
              on: { leftColumn: 'orders.user_id', rightColumn: 'users.id' },
            },
          ],
        };

        const { sql } = compiler.compile(ast, mockCtx);

        expect(sql).toContain('INNER JOIN "users" ON orders.user_id = users.id');
      });

      it('should compile SELECT with JOIN and alias', () => {
        const ast: QueryAST = {
          type: 'select',
          table: 'orders',
          columns: ['*'],
          where: [],
          joins: [
            {
              type: 'LEFT',
              table: 'users',
              alias: 'u',
              on: { leftColumn: 'orders.user_id', rightColumn: 'u.id' },
            },
          ],
        };

        const { sql } = compiler.compile(ast, mockCtx);

        expect(sql).toContain('LEFT JOIN "users" AS "u" ON orders.user_id = u.id');
      });
    });

    describe('INSERT queries', () => {
      it('should compile INSERT with tenant injection', () => {
        const ast: QueryAST = {
          type: 'insert',
          table: 'users',
          data: { name: 'John', email: 'john@example.com' },
        };

        const { sql, params } = compiler.compile(ast, mockCtx);

        expect(sql).toContain('INSERT INTO "users"');
        expect(sql).toContain('"app_id"');
        expect(sql).toContain('"organization_id"');
        expect(params).toContain('test-app');
        expect(params).toContain('org-123');
        expect(params).toContain('John');
        expect(params).toContain('john@example.com');
      });

      it('should compile INSERT with RETURNING (PostgreSQL)', () => {
        const ast: QueryAST = {
          type: 'insert',
          table: 'users',
          data: { name: 'John' },
          returning: ['id', 'name'],
        };

        const { sql } = compiler.compile(ast, mockCtx);

        expect(sql).toContain('RETURNING "id", "name"');
      });
    });

    describe('UPDATE queries', () => {
      it('should compile UPDATE with tenant injection', () => {
        const ast: QueryAST = {
          type: 'update',
          table: 'users',
          data: { name: 'Jane' },
          where: [{ column: 'id', op: '=', value: '123' }],
        };

        const { sql, params } = compiler.compile(ast, mockCtx);

        expect(sql).toContain('UPDATE "users" SET "name" = $1');
        expect(sql).toContain('"app_id" = $2 AND "organization_id" = $3');
        expect(sql).toContain('"id" = $4');
        expect(params).toEqual(['Jane', 'test-app', 'org-123', '123']);
      });

      it('should compile UPDATE with RETURNING (PostgreSQL)', () => {
        const ast: QueryAST = {
          type: 'update',
          table: 'users',
          data: { name: 'Jane' },
          where: [],
          returning: ['id', 'updated_at'],
        };

        const { sql } = compiler.compile(ast, mockCtx);

        expect(sql).toContain('RETURNING "id", "updated_at"');
      });
    });

    describe('DELETE queries', () => {
      it('should compile DELETE with tenant injection', () => {
        const ast: QueryAST = {
          type: 'delete',
          table: 'users',
          where: [{ column: 'id', op: '=', value: '123' }],
        };

        const { sql, params } = compiler.compile(ast, mockCtx);

        expect(sql).toBe(
          'DELETE FROM "users" WHERE "app_id" = $1 AND "organization_id" = $2 AND "id" = $3'
        );
        expect(params).toEqual(['test-app', 'org-123', '123']);
      });

      it('should compile DELETE with RETURNING (PostgreSQL)', () => {
        const ast: QueryAST = {
          type: 'delete',
          table: 'users',
          where: [],
          returning: ['id'],
        };

        const { sql } = compiler.compile(ast, mockCtx);

        expect(sql).toContain('RETURNING "id"');
      });
    });

    describe('Parameter ordering', () => {
      it('should order parameters correctly for complex query', () => {
        const ast: QueryAST = {
          type: 'select',
          table: 'users',
          columns: ['*'],
          where: [
            { column: 'status', op: '=', value: 'active' },
            { column: 'role', op: '=', value: 'admin' },
            { column: 'age', op: '>', value: 18 },
          ],
        };

        const { params } = compiler.compile(ast, mockCtx);

        expect(params[0]).toBe('test-app'); // $1 - app_id
        expect(params[1]).toBe('org-123'); // $2 - org_id
        expect(params[2]).toBe('active'); // $3 - status
        expect(params[3]).toBe('admin'); // $4 - role
        expect(params[4]).toBe(18); // $5 - age
      });
    });

    describe('Identifier quoting', () => {
      it('should quote table names with double quotes', () => {
        const ast: QueryAST = {
          type: 'select',
          table: 'user_profiles',
          columns: ['*'],
          where: [],
        };

        const { sql } = compiler.compile(ast, mockCtx);

        expect(sql).toContain('"user_profiles"');
      });

      it('should quote column names with double quotes', () => {
        const ast: QueryAST = {
          type: 'select',
          table: 'users',
          columns: ['*'],
          where: [{ column: 'first_name', op: '=', value: 'John' }],
        };

        const { sql } = compiler.compile(ast, mockCtx);

        expect(sql).toContain('"first_name"');
      });
    });
  });

  describe('MySQL dialect', () => {
    const compiler = createCompiler({ dialect: 'mysql' });

    it('should use ? placeholders', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        columns: ['*'],
        where: [{ column: 'status', op: '=', value: 'active' }],
      };

      const { sql } = compiler.compile(ast, mockCtx);

      expect(sql).toContain('`app_id` = ?');
      expect(sql).toContain('`organization_id` = ?');
      expect(sql).toContain('`status` = ?');
    });

    it('should use backticks for identifiers', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        columns: ['*'],
        where: [],
      };

      const { sql } = compiler.compile(ast, mockCtx);

      expect(sql).toContain('`users`');
      expect(sql).toContain('`app_id`');
    });

    it('should throw error when RETURNING clause is requested', () => {
      const ast: QueryAST = {
        type: 'insert',
        table: 'users',
        data: { name: 'John' },
        returning: ['id'],
      };

      expect(() => compiler.compile(ast, mockCtx)).toThrow(
        'MySQL does not support RETURNING clause'
      );
    });
  });

  describe('SQLite dialect', () => {
    const compiler = createCompiler({ dialect: 'sqlite' });

    it('should use ? placeholders', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        columns: ['*'],
        where: [{ column: 'status', op: '=', value: 'active' }],
      };

      const { sql } = compiler.compile(ast, mockCtx);

      expect(sql).toContain('"app_id" = ?');
      expect(sql).toContain('"status" = ?');
    });

    it('should use double quotes for identifiers', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        columns: ['*'],
        where: [],
      };

      const { sql } = compiler.compile(ast, mockCtx);

      expect(sql).toContain('"users"');
      expect(sql).toContain('"app_id"');
    });

    it('should support RETURNING clause', () => {
      const ast: QueryAST = {
        type: 'insert',
        table: 'users',
        data: { name: 'John' },
        returning: ['id', 'name'],
      };

      const { sql } = compiler.compile(ast, mockCtx);

      expect(sql).toContain('RETURNING "id", "name"');
    });
  });

  describe('Tenant injection', () => {
    it('should skip tenant injection when injectTenant is false', () => {
      const compiler = createCompiler({ dialect: 'postgresql', injectTenant: false });

      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        columns: ['*'],
        where: [],
      };

      const { sql, params } = compiler.compile(ast, mockCtx);

      expect(sql).toBe('SELECT * FROM "users"');
      expect(params).toEqual([]);
    });

    it('should skip tenant injection when no context provided', () => {
      const compiler = createCompiler({ dialect: 'postgresql' });

      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        columns: ['*'],
        where: [],
      };

      const { sql, params } = compiler.compile(ast);

      expect(sql).toBe('SELECT * FROM "users"');
      expect(params).toEqual([]);
    });

    it('should use custom tenant column names', () => {
      const compiler = createCompiler({
        dialect: 'postgresql',
        tenantColumns: {
          appId: 'tenant_app',
          organizationId: 'tenant_org',
        },
      });

      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        columns: ['*'],
        where: [],
      };

      const { sql } = compiler.compile(ast, mockCtx);

      expect(sql).toContain('"tenant_app"');
      expect(sql).toContain('"tenant_org"');
    });
  });

  describe('Error handling', () => {
    const compiler = createCompiler({ dialect: 'postgresql' });

    it('should throw on unsupported query type', () => {
      const ast = {
        type: 'unsupported' as any,
        table: 'users',
      } as QueryAST;

      expect(() => compiler.compile(ast, mockCtx)).toThrow('Unsupported query type');
    });
  });

  describe('createCompiler factory', () => {
    it('should create a compiler instance', () => {
      const compiler = createCompiler({ dialect: 'postgresql' });
      expect(compiler).toBeInstanceOf(SQLCompiler);
    });
  });
});
