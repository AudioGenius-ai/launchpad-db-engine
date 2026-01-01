import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Driver } from '../driver/types.js';
import type { DialectName, QueryResult } from '../types/index.js';
import { type SeedResult, Seeder } from './base.js';

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

class TestSeeder extends Seeder {
  static order = 5;
  static dependencies = ['users'];
  static version = 2;

  async run(): Promise<SeedResult> {
    await this.execute('INSERT INTO test VALUES (1)');
    return { count: 1 };
  }

  async rollback(): Promise<void> {
    await this.execute('DELETE FROM test');
  }
}

class BasicSeeder extends Seeder {
  async run(): Promise<SeedResult> {
    return { count: 0 };
  }
}

describe('Seeder', () => {
  let mockDriver: Driver;

  beforeEach(() => {
    mockDriver = createMockDriver();
  });

  describe('metadata', () => {
    it('should extract metadata from static properties', () => {
      const seeder = new TestSeeder(mockDriver);
      const metadata = seeder.metadata;

      expect(metadata.name).toBe('test');
      expect(metadata.order).toBe(5);
      expect(metadata.dependencies).toEqual(['users']);
      expect(metadata.version).toBe(2);
    });

    it('should use defaults for basic seeder', () => {
      const seeder = new BasicSeeder(mockDriver);
      const metadata = seeder.metadata;

      expect(metadata.name).toBe('basic');
      expect(metadata.order).toBe(0);
      expect(metadata.dependencies).toEqual([]);
      expect(metadata.version).toBe(1);
    });

    it('should remove Seeder suffix from class name', () => {
      const seeder = new TestSeeder(mockDriver);
      expect(seeder.metadata.name).toBe('test');
    });
  });

  describe('run', () => {
    it('should call execute with correct SQL', async () => {
      const seeder = new TestSeeder(mockDriver);
      const result = await seeder.run();

      expect(result.count).toBe(1);
      expect(mockDriver.execute).toHaveBeenCalledWith('INSERT INTO test VALUES (1)', undefined);
    });
  });

  describe('rollback', () => {
    it('should execute rollback SQL', async () => {
      const seeder = new TestSeeder(mockDriver);
      await seeder.rollback();

      expect(mockDriver.execute).toHaveBeenCalledWith('DELETE FROM test', undefined);
    });

    it('should throw if rollback not implemented', async () => {
      const seeder = new BasicSeeder(mockDriver);
      await expect(seeder.rollback()).rejects.toThrow('Rollback not implemented');
    });
  });

  describe('query', () => {
    it('should delegate to driver query', async () => {
      const seeder = new TestSeeder(mockDriver);
      (mockDriver.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{ id: 1 }],
        rowCount: 1,
      });

      const result = await (seeder as any).query('SELECT * FROM test');

      expect(mockDriver.query).toHaveBeenCalledWith('SELECT * FROM test', undefined);
      expect(result.rows).toEqual([{ id: 1 }]);
    });
  });

  describe('transaction', () => {
    it('should delegate to driver transaction', async () => {
      const seeder = new TestSeeder(mockDriver);

      await (seeder as any).transaction(async (trx: any) => {
        await trx.execute('INSERT INTO test VALUES (1)');
      });

      expect(mockDriver.transaction).toHaveBeenCalled();
    });
  });

  describe('custom logger', () => {
    it('should use provided logger', () => {
      const customLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

      const seeder = new TestSeeder(mockDriver, customLogger);
      expect((seeder as any).logger).toBe(customLogger);
    });
  });
});
