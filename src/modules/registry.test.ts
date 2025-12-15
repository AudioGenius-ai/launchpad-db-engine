import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Driver } from '../driver/types.js';
import { ModuleRegistry } from './registry.js';

const createMockDriver = (): Driver => ({
  dialect: 'postgresql',
  execute: vi.fn().mockResolvedValue({ rowCount: 1 }),
  query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  transaction: vi.fn().mockImplementation(async (fn) => {
    const trx = {
      execute: vi.fn().mockResolvedValue({ rowCount: 1 }),
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    };
    return fn(trx);
  }),
  close: vi.fn().mockResolvedValue(undefined),
});

describe('ModuleRegistry', () => {
  let driver: Driver;
  let registry: ModuleRegistry;

  beforeEach(() => {
    driver = createMockDriver();
    registry = new ModuleRegistry(driver);
  });

  describe('ensureTable', () => {
    it('should create the module registry table for PostgreSQL', async () => {
      await registry.ensureTable();

      expect(driver.execute).toHaveBeenCalledWith(
        expect.stringContaining('CREATE TABLE IF NOT EXISTS "lp_module_registry"')
      );
    });

    it('should use custom table name when provided', async () => {
      const customRegistry = new ModuleRegistry(driver, { tableName: 'custom_modules' });
      await customRegistry.ensureTable();

      expect(driver.execute).toHaveBeenCalledWith(
        expect.stringContaining('CREATE TABLE IF NOT EXISTS "custom_modules"')
      );
    });
  });

  describe('register', () => {
    it('should register a new module', async () => {
      await registry.register({
        name: 'workflows',
        displayName: 'Workflows Engine',
        version: '1.0.0',
        migrationPrefix: 'workflows',
      });

      expect(driver.execute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO "lp_module_registry"'),
        expect.arrayContaining(['workflows', 'Workflows Engine', null, '1.0.0', [], 'workflows'])
      );
    });

    it('should register a module with dependencies', async () => {
      await registry.register({
        name: 'identity',
        displayName: 'Identity Service',
        version: '1.0.0',
        migrationPrefix: 'identity',
        dependencies: ['core', 'auth'],
      });

      expect(driver.execute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO "lp_module_registry"'),
        expect.arrayContaining([
          'identity',
          'Identity Service',
          null,
          '1.0.0',
          ['core', 'auth'],
          'identity',
        ])
      );
    });

    it('should register a module with description', async () => {
      await registry.register({
        name: 'cms',
        displayName: 'Content Management',
        description: 'Full-featured CMS',
        version: '1.0.0',
        migrationPrefix: 'cms',
      });

      expect(driver.execute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO "lp_module_registry"'),
        expect.arrayContaining([
          'cms',
          'Content Management',
          'Full-featured CMS',
          '1.0.0',
          [],
          'cms',
        ])
      );
    });
  });

  describe('get', () => {
    it('should return null when module not found', async () => {
      vi.mocked(driver.query).mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await registry.get('nonexistent');

      expect(result).toBeNull();
    });

    it('should return module definition when found', async () => {
      vi.mocked(driver.query).mockResolvedValueOnce({
        rows: [
          {
            name: 'workflows',
            display_name: 'Workflows Engine',
            description: null,
            version: '1.0.0',
            dependencies: [],
            migration_prefix: 'workflows',
          },
        ],
        rowCount: 1,
      });

      const result = await registry.get('workflows');

      expect(result).toEqual({
        name: 'workflows',
        displayName: 'Workflows Engine',
        description: undefined,
        version: '1.0.0',
        dependencies: [],
        migrationPrefix: 'workflows',
      });
    });

    it('should parse JSON dependencies for non-PostgreSQL dialects', async () => {
      vi.mocked(driver.query).mockResolvedValueOnce({
        rows: [
          {
            name: 'identity',
            display_name: 'Identity Service',
            description: 'Auth service',
            version: '1.0.0',
            dependencies: '["core", "auth"]',
            migration_prefix: 'identity',
          },
        ],
        rowCount: 1,
      });

      const result = await registry.get('identity');

      expect(result).toEqual({
        name: 'identity',
        displayName: 'Identity Service',
        description: 'Auth service',
        version: '1.0.0',
        dependencies: ['core', 'auth'],
        migrationPrefix: 'identity',
      });
    });
  });

  describe('list', () => {
    it('should return empty array when no modules registered', async () => {
      vi.mocked(driver.query).mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await registry.list();

      expect(result).toEqual([]);
    });

    it('should return all registered modules', async () => {
      vi.mocked(driver.query).mockResolvedValueOnce({
        rows: [
          {
            name: 'cms',
            display_name: 'Content Management',
            description: null,
            version: '1.0.0',
            dependencies: [],
            migration_prefix: 'cms',
          },
          {
            name: 'workflows',
            display_name: 'Workflows Engine',
            description: 'Automation',
            version: '2.0.0',
            dependencies: ['core'],
            migration_prefix: 'workflows',
          },
        ],
        rowCount: 2,
      });

      const result = await registry.list();

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('cms');
      expect(result[1].name).toBe('workflows');
      expect(result[1].dependencies).toEqual(['core']);
    });
  });

  describe('unregister', () => {
    it('should delete the module from registry', async () => {
      await registry.unregister('workflows');

      expect(driver.execute).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM "lp_module_registry" WHERE name = $1'),
        ['workflows']
      );
    });
  });

  describe('MySQL dialect', () => {
    beforeEach(() => {
      driver = { ...createMockDriver(), dialect: 'mysql' };
      registry = new ModuleRegistry(driver);
    });

    it('should create table with MySQL syntax', async () => {
      await registry.ensureTable();

      expect(driver.execute).toHaveBeenCalledWith(
        expect.stringContaining('CREATE TABLE IF NOT EXISTS `lp_module_registry`')
      );
    });

    it('should register with MySQL syntax', async () => {
      await registry.register({
        name: 'test',
        displayName: 'Test Module',
        version: '1.0.0',
        migrationPrefix: 'test',
      });

      expect(driver.execute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO `lp_module_registry`'),
        expect.arrayContaining(['test', 'Test Module', null, '1.0.0', '[]', 'test'])
      );
    });
  });

  describe('SQLite dialect', () => {
    beforeEach(() => {
      driver = { ...createMockDriver(), dialect: 'sqlite' };
      registry = new ModuleRegistry(driver);
    });

    it('should create table with SQLite syntax', async () => {
      await registry.ensureTable();

      expect(driver.execute).toHaveBeenCalledWith(
        expect.stringContaining('CREATE TABLE IF NOT EXISTS "lp_module_registry"')
      );
      expect(driver.execute).toHaveBeenCalledWith(expect.stringContaining("datetime('now')"));
    });

    it('should register with SQLite syntax', async () => {
      await registry.register({
        name: 'test',
        displayName: 'Test Module',
        version: '1.0.0',
        migrationPrefix: 'test',
      });

      expect(driver.execute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO "lp_module_registry"'),
        expect.arrayContaining(['test', 'Test Module', null, '1.0.0', '[]', 'test'])
      );
    });
  });
});
