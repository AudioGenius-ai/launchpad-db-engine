import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Driver } from '../driver/types.js';
import type { DialectName } from '../types/index.js';
import { SeedTracker } from './tracker.js';

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

describe('SeedTracker', () => {
  let mockDriver: Driver;
  let tracker: SeedTracker;

  beforeEach(() => {
    mockDriver = createMockDriver();
    tracker = new SeedTracker(mockDriver);
  });

  describe('ensureTable', () => {
    it('should create seeds table for PostgreSQL', async () => {
      await tracker.ensureTable();

      expect(mockDriver.execute).toHaveBeenCalledWith(
        expect.stringContaining('CREATE TABLE IF NOT EXISTS "lp_seeds"')
      );
      expect(mockDriver.execute).toHaveBeenCalledWith(
        expect.stringContaining('SERIAL PRIMARY KEY')
      );
    });

    it('should create seeds table for MySQL', async () => {
      mockDriver = createMockDriver('mysql');
      tracker = new SeedTracker(mockDriver);

      await tracker.ensureTable();

      expect(mockDriver.execute).toHaveBeenCalledWith(
        expect.stringContaining('CREATE TABLE IF NOT EXISTS `lp_seeds`')
      );
      expect(mockDriver.execute).toHaveBeenCalledWith(expect.stringContaining('AUTO_INCREMENT'));
    });

    it('should create seeds table for SQLite', async () => {
      mockDriver = createMockDriver('sqlite');
      tracker = new SeedTracker(mockDriver);

      await tracker.ensureTable();

      expect(mockDriver.execute).toHaveBeenCalledWith(expect.stringContaining('AUTOINCREMENT'));
    });

    it('should use custom table name', async () => {
      tracker = new SeedTracker(mockDriver, { tableName: 'custom_seeds' });

      await tracker.ensureTable();

      expect(mockDriver.execute).toHaveBeenCalledWith(expect.stringContaining('"custom_seeds"'));
    });
  });

  describe('hasRun', () => {
    it('should return false when seed has not run', async () => {
      (mockDriver.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      });

      const result = await tracker.hasRun('users', 1);

      expect(result).toBe(false);
      expect(mockDriver.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT 1 FROM "lp_seeds"'),
        ['users', 1]
      );
    });

    it('should return true when seed has run', async () => {
      (mockDriver.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{ '?column?': 1 }],
        rowCount: 1,
      });

      const result = await tracker.hasRun('users', 1);

      expect(result).toBe(true);
    });

    it('should use MySQL syntax', async () => {
      mockDriver = createMockDriver('mysql');
      tracker = new SeedTracker(mockDriver);

      (mockDriver.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      });

      await tracker.hasRun('users', 1);

      expect(mockDriver.query).toHaveBeenCalledWith(expect.stringContaining('`lp_seeds`'), [
        'users',
        1,
      ]);
    });
  });

  describe('record', () => {
    it('should insert seed record for PostgreSQL', async () => {
      await tracker.record('users', 1, { count: 10 }, 100);

      expect(mockDriver.execute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO "lp_seeds"'),
        ['users', 1, 100, 10]
      );
      expect(mockDriver.execute).toHaveBeenCalledWith(
        expect.stringContaining('ON CONFLICT'),
        expect.any(Array)
      );
    });

    it('should insert seed record for MySQL', async () => {
      mockDriver = createMockDriver('mysql');
      tracker = new SeedTracker(mockDriver);

      await tracker.record('users', 1, { count: 10 }, 100);

      expect(mockDriver.execute).toHaveBeenCalledWith(
        expect.stringContaining('ON DUPLICATE KEY UPDATE'),
        expect.any(Array)
      );
    });

    it('should use INSERT OR REPLACE for SQLite', async () => {
      mockDriver = createMockDriver('sqlite');
      tracker = new SeedTracker(mockDriver);

      await tracker.record('users', 1, { count: 10 }, 100);

      expect(mockDriver.execute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT OR REPLACE'),
        expect.any(Array)
      );
    });
  });

  describe('remove', () => {
    it('should delete seed record', async () => {
      await tracker.remove('users');

      expect(mockDriver.execute).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM "lp_seeds"'),
        ['users']
      );
    });
  });

  describe('clear', () => {
    it('should delete all seed records for PostgreSQL', async () => {
      await tracker.clear();

      expect(mockDriver.execute).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM "lp_seeds"')
      );
    });

    it('should truncate for MySQL', async () => {
      mockDriver = createMockDriver('mysql');
      tracker = new SeedTracker(mockDriver);

      await tracker.clear();

      expect(mockDriver.execute).toHaveBeenCalledWith(expect.stringContaining('TRUNCATE TABLE'));
    });
  });

  describe('list', () => {
    it('should return all seed records', async () => {
      const records = [
        {
          id: 1,
          name: 'users',
          version: 1,
          executed_at: new Date(),
          execution_time_ms: 50,
          record_count: 10,
        },
        {
          id: 2,
          name: 'products',
          version: 1,
          executed_at: new Date(),
          execution_time_ms: 100,
          record_count: 25,
        },
      ];

      (mockDriver.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: records,
        rowCount: 2,
      });

      const result = await tracker.list();

      expect(result).toEqual(records);
      expect(mockDriver.query).toHaveBeenCalledWith(
        expect.stringContaining('ORDER BY executed_at DESC')
      );
    });
  });
});
