import { describe, expect, it } from 'vitest';
import {
  BOUNDARY_VALUES,
  LARGE_DATASET_GENERATORS,
  SPECIAL_SQL_CHARACTERS,
  SQL_INJECTION_PAYLOADS,
  UNICODE_EDGE_CASES,
} from '../../tests/fixtures/special-characters.js';
import type { QueryAST, TenantContext } from '../types/index.js';
import { createCompiler } from './index.js';

const mockCtx: TenantContext = {
  appId: 'test-app',
  organizationId: 'org-123',
};

describe('SQL Compiler Edge Cases', () => {
  describe('Large IN Clause Compilation', () => {
    const compiler = createCompiler({ dialect: 'postgresql' });

    it('should compile IN with 10 values', () => {
      const values = LARGE_DATASET_GENERATORS.generateIds(10);
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        columns: ['*'],
        where: [{ column: 'id', op: 'IN', value: values }],
      };

      const { sql, params } = compiler.compile(ast, mockCtx);

      expect(sql).toContain('IN (');
      expect(params.length).toBe(12); // 2 tenant + 10 values
    });

    it('should compile IN with 100 values', () => {
      const values = LARGE_DATASET_GENERATORS.generateIds(100);
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        columns: ['*'],
        where: [{ column: 'id', op: 'IN', value: values }],
      };

      const { sql, params } = compiler.compile(ast, mockCtx);

      expect(sql).toContain('IN (');
      expect(params.length).toBe(102); // 2 tenant + 100 values
    });

    it('should compile IN with 1000 values', () => {
      const values = LARGE_DATASET_GENERATORS.generateIds(1000);
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        columns: ['*'],
        where: [{ column: 'id', op: 'IN', value: values }],
      };

      const { sql, params } = compiler.compile(ast, mockCtx);

      expect(sql).toContain('IN (');
      expect(params.length).toBe(1002); // 2 tenant + 1000 values
      expect(sql.match(/\$\d+/g)?.length).toBe(1002);
    });

    it('should compile NOT IN with 100 values', () => {
      const values = LARGE_DATASET_GENERATORS.generateIds(100);
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        columns: ['*'],
        where: [{ column: 'id', op: 'NOT IN', value: values }],
      };

      const { sql, params } = compiler.compile(ast, mockCtx);

      expect(sql).toContain('NOT IN (');
      expect(params.length).toBe(102);
    });

    it('should compile IN with string values', () => {
      const values = LARGE_DATASET_GENERATORS.generateStrings(50);
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        columns: ['*'],
        where: [{ column: 'status', op: 'IN', value: values }],
      };

      const { sql, params } = compiler.compile(ast, mockCtx);

      expect(sql).toContain('IN (');
      expect(params.slice(2)).toEqual(values);
    });

    it('should handle IN with mixed types', () => {
      const values = [1, '2', 3, 'four', 5];
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        columns: ['*'],
        where: [{ column: 'id', op: 'IN', value: values }],
      };

      const { params } = compiler.compile(ast, mockCtx);

      expect(params.slice(2)).toEqual(values);
    });
  });

  describe('SQL Injection Prevention', () => {
    const compiler = createCompiler({ dialect: 'postgresql' });

    describe('Classic SQL Injection Payloads', () => {
      for (const { input, description } of SQL_INJECTION_PAYLOADS) {
        it(`should safely handle: ${description}`, () => {
          const ast: QueryAST = {
            type: 'select',
            table: 'users',
            columns: ['*'],
            where: [{ column: 'name', op: '=', value: input }],
          };

          const { sql, params } = compiler.compile(ast, mockCtx);

          expect(sql).not.toContain('DROP TABLE');
          expect(sql).not.toContain('DELETE FROM');
          expect(sql).not.toContain('UNION SELECT');
          expect(sql).toContain('$3');
          expect(params[2]).toBe(input);
        });
      }
    });

    describe('Unicode Edge Cases', () => {
      for (const { char, name } of UNICODE_EDGE_CASES) {
        it(`should safely handle: ${name}`, () => {
          const testValue = `test${char}value`;
          const ast: QueryAST = {
            type: 'select',
            table: 'users',
            columns: ['*'],
            where: [{ column: 'name', op: '=', value: testValue }],
          };

          const { sql, params } = compiler.compile(ast, mockCtx);

          expect(sql).toContain('$3');
          expect(params[2]).toBe(testValue);
        });
      }
    });

    describe('Special SQL Characters', () => {
      const dangerousChars = SPECIAL_SQL_CHARACTERS.filter(
        ({ char }) => !["'", '"', '`', '_', '%'].includes(char)
      );

      for (const { char, name } of dangerousChars) {
        it(`should safely handle: ${name}`, () => {
          const testValue = `before${char}after`;
          const ast: QueryAST = {
            type: 'insert',
            table: 'users',
            data: { name: testValue },
          };

          const { sql, params } = compiler.compile(ast, mockCtx);

          expect(sql).not.toContain(char === '$' ? '' : char);
          expect(params).toContain(testValue);
        });
      }

      it('should parameterize values containing single quotes', () => {
        const testValue = "test'value";
        const ast: QueryAST = {
          type: 'insert',
          table: 'users',
          data: { name: testValue },
        };

        const { sql, params } = compiler.compile(ast, mockCtx);

        expect(sql).toContain('$');
        expect(params).toContain(testValue);
      });

      it('should parameterize values containing double quotes', () => {
        const testValue = 'test"value';
        const ast: QueryAST = {
          type: 'insert',
          table: 'users',
          data: { name: testValue },
        };

        const { params } = compiler.compile(ast, mockCtx);

        expect(params).toContain(testValue);
      });

      it('should parameterize values containing LIKE wildcards', () => {
        const testValue = 'test%_value';
        const ast: QueryAST = {
          type: 'insert',
          table: 'users',
          data: { name: testValue },
        };

        const { params } = compiler.compile(ast, mockCtx);

        expect(params).toContain(testValue);
      });
    });

    it('should parameterize IN clause with injection attempts', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        columns: ['*'],
        where: [
          {
            column: 'id',
            op: 'IN',
            value: ["1'; DROP TABLE users; --", '2', '3'],
          },
        ],
      };

      const { sql, params } = compiler.compile(ast, mockCtx);

      expect(sql).not.toContain('DROP TABLE');
      expect(params[2]).toBe("1'; DROP TABLE users; --");
    });

    it('should quote malicious table names', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'users; DROP TABLE users; --',
        columns: ['*'],
        where: [],
      };

      const { sql } = compiler.compile(ast, mockCtx);

      expect(sql).toContain('"users; DROP TABLE users; --"');
      expect(sql).not.toMatch(/FROM users; DROP/);
    });

    it('should quote malicious column names', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        columns: ['id', 'name; DROP TABLE users; --'],
        where: [],
      };

      const { sql } = compiler.compile(ast, mockCtx);

      expect(sql).toContain('"name; DROP TABLE users; --"');
    });

    it('should parameterize UPDATE values with injection', () => {
      const ast: QueryAST = {
        type: 'update',
        table: 'users',
        data: { name: "admin'; DROP TABLE users; --" },
        where: [{ column: 'id', op: '=', value: '1' }],
      };

      const { sql, params } = compiler.compile(ast, mockCtx);

      expect(sql).not.toContain('DROP TABLE');
      expect(params[0]).toBe("admin'; DROP TABLE users; --");
    });

    it('should handle LIKE pattern with special characters', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        columns: ['*'],
        where: [{ column: 'name', op: 'LIKE', value: "%test'%--%" }],
      };

      const { sql, params } = compiler.compile(ast, mockCtx);

      expect(sql).toContain('LIKE $3');
      expect(params[2]).toBe("%test'%--%");
    });
  });

  describe('Boundary Values', () => {
    const compiler = createCompiler({ dialect: 'postgresql' });

    it('should handle max int32 value', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        columns: ['*'],
        where: [{ column: 'count', op: '=', value: BOUNDARY_VALUES.integers.maxInt32 }],
      };

      const { params } = compiler.compile(ast, mockCtx);

      expect(params[2]).toBe(2147483647);
    });

    it('should handle min int32 value', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        columns: ['*'],
        where: [{ column: 'count', op: '=', value: BOUNDARY_VALUES.integers.minInt32 }],
      };

      const { params } = compiler.compile(ast, mockCtx);

      expect(params[2]).toBe(-2147483648);
    });

    it('should handle zero value', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        columns: ['*'],
        where: [{ column: 'count', op: '=', value: 0 }],
      };

      const { params } = compiler.compile(ast, mockCtx);

      expect(params[2]).toBe(0);
    });

    it('should handle empty string value', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        columns: ['*'],
        where: [{ column: 'name', op: '=', value: '' }],
      };

      const { params } = compiler.compile(ast, mockCtx);

      expect(params[2]).toBe('');
    });

    it('should handle very long string value', () => {
      const longString = 'a'.repeat(10000);
      const ast: QueryAST = {
        type: 'insert',
        table: 'users',
        data: { name: longString },
      };

      const { params } = compiler.compile(ast, mockCtx);

      expect(params).toContain(longString);
    });

    it('should handle whitespace-only string', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        columns: ['*'],
        where: [{ column: 'name', op: '=', value: '   ' }],
      };

      const { params } = compiler.compile(ast, mockCtx);

      expect(params[2]).toBe('   ');
    });
  });

  describe('Complex Query Compilation', () => {
    const compiler = createCompiler({ dialect: 'postgresql' });

    it('should compile query with multiple JOINs and aliases', () => {
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
          {
            type: 'INNER',
            table: 'products',
            alias: 'p',
            on: { leftColumn: 'orders.product_id', rightColumn: 'p.id' },
          },
        ],
      };

      const { sql } = compiler.compile(ast, mockCtx);

      expect(sql).toContain('LEFT JOIN "users" AS "u"');
      expect(sql).toContain('INNER JOIN "products" AS "p"');
    });

    it('should compile complex OR/AND conditions', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        columns: ['*'],
        where: [
          { column: 'status', op: '=', value: 'active' },
          { column: 'role', op: '=', value: 'admin', connector: 'OR' },
          { column: 'verified', op: '=', value: true },
        ],
      };

      const { sql } = compiler.compile(ast, mockCtx);

      expect(sql).toContain('"status" = $3');
      expect(sql).toContain('OR "role" = $4');
      expect(sql).toContain('AND "verified" = $5');
    });

    it('should compile GROUP BY with multiple columns', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'orders',
        columns: ['status', 'category', 'COUNT(*)'],
        where: [],
        groupBy: { columns: ['status', 'category'] },
      };

      const { sql } = compiler.compile(ast, mockCtx);

      expect(sql).toContain('GROUP BY "status", "category"');
    });

    it('should compile multiple HAVING conditions', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'orders',
        columns: ['status'],
        where: [],
        groupBy: { columns: ['status'] },
        having: [
          { column: 'count', op: '>', value: 5 },
          { column: 'total', op: '<', value: 1000 },
        ],
      };

      const { sql, params } = compiler.compile(ast, mockCtx);

      expect(sql).toContain('HAVING "count" > $3 AND "total" < $4');
      expect(params[2]).toBe(5);
      expect(params[3]).toBe(1000);
    });
  });

  describe('Insert Many Compilation', () => {
    const compiler = createCompiler({ dialect: 'postgresql' });

    it('should compile insert with 10 rows', () => {
      const rows = LARGE_DATASET_GENERATORS.generateRows(10);
      const ast: QueryAST = {
        type: 'insert',
        table: 'users',
        dataRows: rows,
      };

      const { sql, params } = compiler.compile(ast, mockCtx);

      expect(sql).toContain('INSERT INTO "users"');
      expect(sql).toContain('VALUES');
      expect(params.length).toBe(10 * 4); // 10 rows * 4 columns (2 tenant + 2 data)
    });

    it('should compile insert with 100 rows', () => {
      const rows = LARGE_DATASET_GENERATORS.generateRows(100);
      const ast: QueryAST = {
        type: 'insert',
        table: 'users',
        dataRows: rows,
      };

      const { sql, params } = compiler.compile(ast, mockCtx);

      expect(sql).toContain('INSERT INTO "users"');
      expect(params.length).toBe(100 * 4);
    });

    it('should compile insert many with RETURNING', () => {
      const rows = LARGE_DATASET_GENERATORS.generateRows(5);
      const ast: QueryAST = {
        type: 'insert',
        table: 'users',
        dataRows: rows,
        returning: ['id', 'name', 'email'],
      };

      const { sql } = compiler.compile(ast, mockCtx);

      expect(sql).toContain('RETURNING "id", "name", "email"');
    });

    it('should compile insert many with ON CONFLICT', () => {
      const rows = LARGE_DATASET_GENERATORS.generateRows(5);
      const ast: QueryAST = {
        type: 'insert',
        table: 'users',
        dataRows: rows,
        onConflict: {
          columns: ['email'],
          action: 'update',
        },
      };

      const { sql } = compiler.compile(ast, mockCtx);

      expect(sql).toContain('ON CONFLICT ("email") DO UPDATE SET');
    });
  });

  describe('MySQL Dialect Edge Cases', () => {
    const compiler = createCompiler({ dialect: 'mysql' });

    it('should use ? placeholders for large IN clause', () => {
      const values = LARGE_DATASET_GENERATORS.generateIds(50);
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        columns: ['*'],
        where: [{ column: 'id', op: 'IN', value: values }],
      };

      const { sql } = compiler.compile(ast, mockCtx);

      expect(sql).toContain('`id` IN (');
      expect(sql.match(/\?/g)?.length).toBe(52); // 2 tenant + 50 values
    });

    it('should use backticks for identifiers with special characters', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'user-data',
        columns: ['user-id', 'user-name'],
        where: [],
      };

      const { sql } = compiler.compile(ast, mockCtx);

      expect(sql).toContain('`user-data`');
      expect(sql).toContain('`user-id`');
      expect(sql).toContain('`user-name`');
    });

    it('should compile ON DUPLICATE KEY UPDATE for MySQL', () => {
      const ast: QueryAST = {
        type: 'insert',
        table: 'users',
        data: { name: 'Test', email: 'test@example.com' },
        onConflict: { columns: ['email'], action: 'update' },
      };

      const { sql } = compiler.compile(ast, mockCtx);

      expect(sql).toContain('ON DUPLICATE KEY UPDATE');
    });
  });

  describe('SQLite Dialect Edge Cases', () => {
    const compiler = createCompiler({ dialect: 'sqlite' });

    it('should use ? placeholders for large IN clause', () => {
      const values = LARGE_DATASET_GENERATORS.generateIds(50);
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        columns: ['*'],
        where: [{ column: 'id', op: 'IN', value: values }],
      };

      const { sql } = compiler.compile(ast, mockCtx);

      expect(sql).toContain('"id" IN (');
      expect(sql.match(/\?/g)?.length).toBe(52); // 2 tenant + 50 values
    });

    it('should support RETURNING clause', () => {
      const ast: QueryAST = {
        type: 'insert',
        table: 'users',
        data: { name: 'Test' },
        returning: ['id', 'name'],
      };

      const { sql } = compiler.compile(ast, mockCtx);

      expect(sql).toContain('RETURNING "id", "name"');
    });
  });

  describe('Error Handling Edge Cases', () => {
    const compiler = createCompiler({ dialect: 'postgresql' });

    it('should throw error for empty dataRows array', () => {
      const ast: QueryAST = {
        type: 'insert',
        table: 'users',
        dataRows: [],
      };

      expect(() => compiler.compile(ast, mockCtx)).toThrow('Cannot insert empty array of rows');
    });

    it('should throw error for invalid ORDER BY direction', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        columns: ['*'],
        where: [],
        orderBy: { column: 'name', direction: 'INVALID' as 'asc' },
      };

      expect(() => compiler.compile(ast, mockCtx)).toThrow('Invalid ORDER BY direction');
    });

    it('should throw error when tenant context missing', () => {
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        columns: ['*'],
        where: [],
      };

      expect(() => compiler.compile(ast)).toThrow(
        'Tenant context is required when tenant injection is enabled'
      );
    });

    it('should throw error for unsupported query type', () => {
      const ast = {
        type: 'merge' as unknown,
        table: 'users',
      } as QueryAST;

      expect(() => compiler.compile(ast, mockCtx)).toThrow('Unsupported query type');
    });
  });

  describe('Tenant Injection Edge Cases', () => {
    it('should skip tenant injection when disabled', () => {
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

    it('should use custom tenant column names', () => {
      const compiler = createCompiler({
        dialect: 'postgresql',
        tenantColumns: {
          appId: 'tenant_id',
          organizationId: 'org_uuid',
        },
      });
      const ast: QueryAST = {
        type: 'select',
        table: 'users',
        columns: ['*'],
        where: [],
      };

      const { sql } = compiler.compile(ast, mockCtx);

      expect(sql).toContain('"tenant_id"');
      expect(sql).toContain('"org_uuid"');
    });
  });
});
