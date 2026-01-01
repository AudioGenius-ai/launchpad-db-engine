import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Driver } from '../driver/types.js';
import type { DialectName } from '../types/index.js';
import { SqlSeederAdapter } from './sql-adapter.js';

function createMockDriver(dialect: DialectName = 'postgresql'): Driver {
  return {
    dialect,
    connectionString: `${dialect}://localhost`,
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    execute: vi.fn(async () => ({ rowCount: 1 })),
    transaction: vi.fn(async (fn) => {
      const trxClient = {
        query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
        execute: vi.fn(async () => ({ rowCount: 1 })),
      };
      return fn(trxClient);
    }),
    close: vi.fn(async () => {}),
  };
}

describe('SqlSeederAdapter', () => {
  let mockDriver: Driver;

  beforeEach(() => {
    mockDriver = createMockDriver();
  });

  describe('run', () => {
    it('should execute single statement', async () => {
      const sql = "INSERT INTO users (name) VALUES ('John')";
      const adapter = new SqlSeederAdapter(mockDriver, sql, 'users');

      const result = await adapter.run();

      expect(result.count).toBe(1);
      expect(mockDriver.execute).toHaveBeenCalledWith(sql, undefined);
    });

    it('should execute multiple statements separated by semicolons', async () => {
      const sql = `
        INSERT INTO users (name) VALUES ('John');
        INSERT INTO users (name) VALUES ('Jane');
        INSERT INTO users (name) VALUES ('Bob')
      `;
      const adapter = new SqlSeederAdapter(mockDriver, sql, 'users');

      (mockDriver.execute as ReturnType<typeof vi.fn>).mockResolvedValue({ rowCount: 1 });

      const result = await adapter.run();

      expect(result.count).toBe(3);
      expect(mockDriver.execute).toHaveBeenCalledTimes(3);
    });

    it('should handle empty statements gracefully', async () => {
      const sql = `
        INSERT INTO users (name) VALUES ('John');
        ;
        INSERT INTO users (name) VALUES ('Jane')
      `;
      const adapter = new SqlSeederAdapter(mockDriver, sql, 'users');

      (mockDriver.execute as ReturnType<typeof vi.fn>).mockResolvedValue({ rowCount: 1 });

      const result = await adapter.run();

      expect(result.count).toBe(2);
      expect(mockDriver.execute).toHaveBeenCalledTimes(2);
    });
  });

  describe('splitStatements', () => {
    it('should preserve strings with semicolons', async () => {
      const sql = "INSERT INTO test (data) VALUES ('a;b;c')";
      const adapter = new SqlSeederAdapter(mockDriver, sql, 'test');

      await adapter.run();

      expect(mockDriver.execute).toHaveBeenCalledWith(sql, undefined);
    });

    it('should handle escaped single quotes', async () => {
      const sql = "INSERT INTO test (data) VALUES ('it''s working')";
      const adapter = new SqlSeederAdapter(mockDriver, sql, 'test');

      await adapter.run();

      expect(mockDriver.execute).toHaveBeenCalledWith(sql, undefined);
    });

    it('should handle double-quoted identifiers', async () => {
      const sql = 'INSERT INTO "test;table" (data) VALUES (1)';
      const adapter = new SqlSeederAdapter(mockDriver, sql, 'test');

      await adapter.run();

      expect(mockDriver.execute).toHaveBeenCalledWith(sql, undefined);
    });

    it('should handle dollar-quoted strings (PostgreSQL)', async () => {
      const sql = `
        CREATE FUNCTION test() RETURNS void AS $$
        BEGIN
          INSERT INTO log VALUES ('started;');
        END;
        $$ LANGUAGE plpgsql;
        SELECT 1
      `;
      const adapter = new SqlSeederAdapter(mockDriver, sql, 'test');

      (mockDriver.execute as ReturnType<typeof vi.fn>).mockResolvedValue({ rowCount: 1 });

      await adapter.run();

      expect(mockDriver.execute).toHaveBeenCalledTimes(2);
    });

    it('should handle line comments', async () => {
      const sql = `
        INSERT INTO test VALUES (1); -- this is a comment
        INSERT INTO test VALUES (2)
      `;
      const adapter = new SqlSeederAdapter(mockDriver, sql, 'test');

      (mockDriver.execute as ReturnType<typeof vi.fn>).mockResolvedValue({ rowCount: 1 });

      await adapter.run();

      expect(mockDriver.execute).toHaveBeenCalledTimes(2);
    });

    it('should handle block comments', async () => {
      const sql = `
        INSERT INTO test VALUES (1); /* this; is; a; comment */
        INSERT INTO test VALUES (2)
      `;
      const adapter = new SqlSeederAdapter(mockDriver, sql, 'test');

      (mockDriver.execute as ReturnType<typeof vi.fn>).mockResolvedValue({ rowCount: 1 });

      await adapter.run();

      expect(mockDriver.execute).toHaveBeenCalledTimes(2);
    });

    it('should handle tagged dollar quotes', async () => {
      const sql = `
        CREATE FUNCTION foo() RETURNS void AS $body$
        BEGIN
          RAISE NOTICE 'semicolon; here';
        END;
        $body$ LANGUAGE plpgsql;
        SELECT 1
      `;
      const adapter = new SqlSeederAdapter(mockDriver, sql, 'test');

      (mockDriver.execute as ReturnType<typeof vi.fn>).mockResolvedValue({ rowCount: 1 });

      await adapter.run();

      expect(mockDriver.execute).toHaveBeenCalledTimes(2);
    });
  });
});
