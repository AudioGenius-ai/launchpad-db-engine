import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Driver } from '../driver/types.js';
import type { DialectName } from '../types/index.js';
import { SeedRunner, createSeedRunner } from './runner.js';

function createMockDriver(dialect: DialectName = 'postgresql'): Driver {
  return {
    dialect,
    connectionString: `${dialect}://localhost`,
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    execute: vi.fn(async () => ({ rowCount: 1 })),
    transaction: vi.fn(async (fn) => {
      return fn({
        query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
        execute: vi.fn(async () => ({ rowCount: 1 })),
      });
    }),
    close: vi.fn(async () => {}),
  };
}

describe('SeedRunner', () => {
  let mockDriver: Driver;
  let runner: SeedRunner;
  let originalEnv: string | undefined;

  beforeEach(() => {
    mockDriver = createMockDriver();
    runner = new SeedRunner(mockDriver, { seedsPath: '/tmp/empty-seeds' });
    originalEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.NODE_ENV = originalEnv;
    } else {
      process.env.NODE_ENV = undefined;
    }
  });

  describe('run', () => {
    it('should return empty result when no seeders found', async () => {
      const result = await runner.run();

      expect(result.success).toBe(true);
      expect(result.seeders).toEqual([]);
      expect(result.totalCount).toBe(0);
      expect(result.totalDuration).toBeGreaterThanOrEqual(0);
    });

    it('should ensure tracker table exists', async () => {
      await runner.run();

      expect(mockDriver.execute).toHaveBeenCalledWith(
        expect.stringContaining('CREATE TABLE IF NOT EXISTS')
      );
    });

    it('should throw in production without allowProduction flag', async () => {
      process.env.NODE_ENV = 'production';

      await expect(runner.run()).rejects.toThrow('Seeding in production is disabled by default');
    });

    it('should allow production with allowProduction flag', async () => {
      process.env.NODE_ENV = 'production';

      const result = await runner.run({ allowProduction: true });

      expect(result.success).toBe(true);
    });
  });

  describe('status', () => {
    it('should return status from tracker', async () => {
      const records = [
        {
          id: 1,
          name: 'users',
          version: 1,
          executed_at: new Date(),
          execution_time_ms: 50,
          record_count: 10,
        },
      ];

      (mockDriver.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: records,
        rowCount: 1,
      });

      const result = await runner.status();

      expect(result.success).toBe(true);
      expect(result.seeders.length).toBe(1);
      expect(result.seeders[0].name).toBe('users');
      expect(result.seeders[0].count).toBe(10);
    });
  });

  describe('filterSeeders', () => {
    it('should return all seeders when no filter', () => {
      const seeders = [
        { name: 'users', path: '', type: 'typescript' as const, order: 1, dependencies: [] },
        { name: 'products', path: '', type: 'typescript' as const, order: 2, dependencies: [] },
      ];

      const filtered = (runner as any).filterSeeders(seeders, {});

      expect(filtered).toEqual(seeders);
    });

    it('should filter by name with --only option', () => {
      const seeders = [
        { name: 'users', path: '', type: 'typescript' as const, order: 1, dependencies: [] },
        { name: 'products', path: '', type: 'typescript' as const, order: 2, dependencies: [] },
      ];

      const filtered = (runner as any).filterSeeders(seeders, { only: 'users' });

      expect(filtered.length).toBe(1);
      expect(filtered[0].name).toBe('users');
    });

    it('should include dependencies when using --only', () => {
      const seeders = [
        { name: 'users', path: '', type: 'typescript' as const, order: 1, dependencies: [] },
        {
          name: 'products',
          path: '',
          type: 'typescript' as const,
          order: 2,
          dependencies: ['users'],
        },
      ];

      const filtered = (runner as any).filterSeeders(seeders, { only: 'products' });

      expect(filtered.length).toBe(2);
      expect(filtered.map((s: any) => s.name)).toContain('users');
      expect(filtered.map((s: any) => s.name)).toContain('products');
    });

    it('should throw when seeder not found', () => {
      const seeders = [
        { name: 'users', path: '', type: 'typescript' as const, order: 1, dependencies: [] },
      ];

      expect(() => (runner as any).filterSeeders(seeders, { only: 'unknown' })).toThrow(
        'Seeder not found: unknown'
      );
    });

    it('should be case-insensitive', () => {
      const seeders = [
        { name: 'Users', path: '', type: 'typescript' as const, order: 1, dependencies: [] },
      ];

      const filtered = (runner as any).filterSeeders(seeders, { only: 'users' });

      expect(filtered.length).toBe(1);
    });
  });

  describe('resolveDependencies', () => {
    it('should resolve nested dependencies', () => {
      const seeders = [
        { name: 'a', path: '', type: 'typescript' as const, order: 1, dependencies: [] },
        { name: 'b', path: '', type: 'typescript' as const, order: 2, dependencies: ['a'] },
        { name: 'c', path: '', type: 'typescript' as const, order: 3, dependencies: ['b'] },
      ];

      const target = seeders[2];
      const resolved = (runner as any).resolveDependencies(target, seeders);

      expect(resolved.length).toBe(3);
      expect(resolved.map((s: any) => s.name)).toEqual(['a', 'b', 'c']);
    });

    it('should handle multiple dependencies', () => {
      const seeders = [
        { name: 'a', path: '', type: 'typescript' as const, order: 1, dependencies: [] },
        { name: 'b', path: '', type: 'typescript' as const, order: 2, dependencies: [] },
        { name: 'c', path: '', type: 'typescript' as const, order: 3, dependencies: ['a', 'b'] },
      ];

      const target = seeders[2];
      const resolved = (runner as any).resolveDependencies(target, seeders);

      expect(resolved.length).toBe(3);
    });

    it('should not duplicate dependencies', () => {
      const seeders = [
        { name: 'a', path: '', type: 'typescript' as const, order: 1, dependencies: [] },
        { name: 'b', path: '', type: 'typescript' as const, order: 2, dependencies: ['a'] },
        { name: 'c', path: '', type: 'typescript' as const, order: 3, dependencies: ['a', 'b'] },
      ];

      const target = seeders[2];
      const resolved = (runner as any).resolveDependencies(target, seeders);

      const names = resolved.map((s: any) => s.name);
      expect(names.filter((n: string) => n === 'a').length).toBe(1);
    });
  });

  describe('createSeedRunner factory', () => {
    it('should create a SeedRunner instance', () => {
      const runner = createSeedRunner(mockDriver, { seedsPath: '/tmp/seeds' });

      expect(runner).toBeInstanceOf(SeedRunner);
    });

    it('should work with default options', () => {
      const runner = createSeedRunner(mockDriver);

      expect(runner).toBeInstanceOf(SeedRunner);
    });
  });
});
