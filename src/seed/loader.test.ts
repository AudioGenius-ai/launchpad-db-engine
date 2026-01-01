import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Driver } from '../driver/types.js';
import type { DialectName } from '../types/index.js';
import { type SeedResult, Seeder } from './base.js';
import { type LoadedSeeder, SeedLoader } from './loader.js';

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

describe('SeedLoader', () => {
  describe('extractName', () => {
    it('should extract name from numbered filename', () => {
      const loader = new SeedLoader({ seedsPath: '/tmp/seeds' });
      const name = (loader as any).extractName('01-users.ts');
      expect(name).toBe('users');
    });

    it('should extract name from underscore numbered filename', () => {
      const loader = new SeedLoader({ seedsPath: '/tmp/seeds' });
      const name = (loader as any).extractName('02_products.ts');
      expect(name).toBe('products');
    });

    it('should handle filename without number prefix', () => {
      const loader = new SeedLoader({ seedsPath: '/tmp/seeds' });
      const name = (loader as any).extractName('users.ts');
      expect(name).toBe('users');
    });

    it('should handle SQL files', () => {
      const loader = new SeedLoader({ seedsPath: '/tmp/seeds' });
      const name = (loader as any).extractName('03-sample-data.sql');
      expect(name).toBe('sample-data');
    });

    it('should handle JS files', () => {
      const loader = new SeedLoader({ seedsPath: '/tmp/seeds' });
      const name = (loader as any).extractName('01-users.js');
      expect(name).toBe('users');
    });
  });

  describe('extractOrderFromFilename', () => {
    it('should extract order from numbered filename with dash', () => {
      const loader = new SeedLoader({ seedsPath: '/tmp/seeds' });
      const order = (loader as any).extractOrderFromFilename('01-users.ts');
      expect(order).toBe(1);
    });

    it('should extract order from numbered filename with underscore', () => {
      const loader = new SeedLoader({ seedsPath: '/tmp/seeds' });
      const order = (loader as any).extractOrderFromFilename('05_products.ts');
      expect(order).toBe(5);
    });

    it('should extract multi-digit order', () => {
      const loader = new SeedLoader({ seedsPath: '/tmp/seeds' });
      const order = (loader as any).extractOrderFromFilename('100-data.ts');
      expect(order).toBe(100);
    });

    it('should return 999 for files without order prefix', () => {
      const loader = new SeedLoader({ seedsPath: '/tmp/seeds' });
      const order = (loader as any).extractOrderFromFilename('users.ts');
      expect(order).toBe(999);
    });
  });

  describe('topologicalSort', () => {
    it('should sort seeders by dependencies', () => {
      const loader = new SeedLoader({ seedsPath: '/tmp/seeds' });

      const seeders: LoadedSeeder[] = [
        { name: 'products', path: '', type: 'typescript', order: 2, dependencies: ['users'] },
        { name: 'users', path: '', type: 'typescript', order: 1, dependencies: [] },
        {
          name: 'orders',
          path: '',
          type: 'typescript',
          order: 3,
          dependencies: ['users', 'products'],
        },
      ];

      const sorted = (loader as any).topologicalSort(seeders);

      const names = sorted.map((s: LoadedSeeder) => s.name);
      expect(names.indexOf('users')).toBeLessThan(names.indexOf('products'));
      expect(names.indexOf('products')).toBeLessThan(names.indexOf('orders'));
      expect(names.indexOf('users')).toBeLessThan(names.indexOf('orders'));
    });

    it('should respect order when no dependencies', () => {
      const loader = new SeedLoader({ seedsPath: '/tmp/seeds' });

      const seeders: LoadedSeeder[] = [
        { name: 'third', path: '', type: 'typescript', order: 3, dependencies: [] },
        { name: 'first', path: '', type: 'typescript', order: 1, dependencies: [] },
        { name: 'second', path: '', type: 'typescript', order: 2, dependencies: [] },
      ];

      const sorted = (loader as any).topologicalSort(seeders);

      expect(sorted.map((s: LoadedSeeder) => s.name)).toEqual(['first', 'second', 'third']);
    });

    it('should throw on unknown dependency', () => {
      const loader = new SeedLoader({ seedsPath: '/tmp/seeds' });

      const seeders: LoadedSeeder[] = [
        { name: 'products', path: '', type: 'typescript', order: 1, dependencies: ['unknown'] },
      ];

      expect(() => (loader as any).topologicalSort(seeders)).toThrow(
        'Seeder "products" depends on unknown seeder "unknown"'
      );
    });

    it('should detect circular dependencies', () => {
      const loader = new SeedLoader({ seedsPath: '/tmp/seeds' });

      const seeders: LoadedSeeder[] = [
        { name: 'a', path: '', type: 'typescript', order: 1, dependencies: ['b'] },
        { name: 'b', path: '', type: 'typescript', order: 2, dependencies: ['c'] },
        { name: 'c', path: '', type: 'typescript', order: 3, dependencies: ['a'] },
      ];

      expect(() => (loader as any).topologicalSort(seeders)).toThrow(
        'Circular dependency detected in seeders'
      );
    });
  });

  describe('createInstance', () => {
    it('should create instance from TypeScript seeder class', () => {
      const loader = new SeedLoader({ seedsPath: '/tmp/seeds' });
      const mockDriver = createMockDriver();

      class UsersSeeder extends Seeder {
        async run(): Promise<SeedResult> {
          return { count: 1 };
        }
      }

      const loaded: LoadedSeeder = {
        name: 'users',
        path: '/tmp/seeds/01-users.ts',
        type: 'typescript',
        order: 1,
        dependencies: [],
        SeederClass: UsersSeeder,
      };

      const instance = loader.createInstance(loaded, mockDriver);

      expect(instance).toBeInstanceOf(Seeder);
      expect(instance).toBeInstanceOf(UsersSeeder);
    });

    it('should create instance from SQL content', () => {
      const loader = new SeedLoader({ seedsPath: '/tmp/seeds' });
      const mockDriver = createMockDriver();

      const loaded: LoadedSeeder = {
        name: 'sample-data',
        path: '/tmp/seeds/02-sample-data.sql',
        type: 'sql',
        order: 2,
        dependencies: [],
        sqlContent: "INSERT INTO users VALUES (1, 'test')",
      };

      const instance = loader.createInstance(loaded, mockDriver);

      expect(instance).toBeInstanceOf(Seeder);
    });

    it('should throw for invalid loaded seeder', () => {
      const loader = new SeedLoader({ seedsPath: '/tmp/seeds' });
      const mockDriver = createMockDriver();

      const loaded: LoadedSeeder = {
        name: 'invalid',
        path: '/tmp/seeds/invalid.ts',
        type: 'typescript',
        order: 1,
        dependencies: [],
      };

      expect(() => loader.createInstance(loaded, mockDriver)).toThrow(
        'Cannot create instance for seeder: invalid'
      );
    });
  });
});
