import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MigrationCollector } from './collector.js';
import * as fs from 'node:fs/promises';

vi.mock('node:fs/promises');

describe('MigrationCollector', () => {
  let collector: MigrationCollector;

  beforeEach(() => {
    collector = new MigrationCollector();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('discoverFromDirectory', () => {
    it('should return empty array when directory does not exist', async () => {
      vi.mocked(fs.readdir).mockRejectedValueOnce(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      );

      const result = await collector.discoverFromDirectory('/nonexistent');

      expect(result).toEqual([]);
    });

    it('should discover module directories', async () => {
      vi.mocked(fs.readdir).mockResolvedValueOnce(['cms', 'workflows', 'identity'] as any);
      vi.mocked(fs.stat).mockImplementation(async (path) => ({
        isDirectory: () => true,
      }) as any);

      const result = await collector.discoverFromDirectory('/migrations/modules');

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({
        moduleName: 'cms',
        migrationsPath: '/migrations/modules/cms',
      });
      expect(result[1]).toEqual({
        moduleName: 'identity',
        migrationsPath: '/migrations/modules/identity',
      });
      expect(result[2]).toEqual({
        moduleName: 'workflows',
        migrationsPath: '/migrations/modules/workflows',
      });
    });

    it('should skip non-directory entries', async () => {
      vi.mocked(fs.readdir).mockResolvedValueOnce(['workflows', 'README.md', '.gitkeep'] as any);
      vi.mocked(fs.stat).mockImplementation(async (path) => ({
        isDirectory: () => !path.includes('.'),
      }) as any);

      const result = await collector.discoverFromDirectory('/migrations/modules');

      expect(result).toHaveLength(1);
      expect(result[0].moduleName).toBe('workflows');
    });

    it('should sort modules alphabetically', async () => {
      vi.mocked(fs.readdir).mockResolvedValueOnce(['workflows', 'auth', 'cms'] as any);
      vi.mocked(fs.stat).mockImplementation(async () => ({ isDirectory: () => true }) as any);

      const result = await collector.discoverFromDirectory('/migrations/modules');

      expect(result.map((s) => s.moduleName)).toEqual(['auth', 'cms', 'workflows']);
    });
  });

  describe('collect', () => {
    it('should return empty array when no sources provided', async () => {
      const result = await collector.collect([]);

      expect(result).toEqual([]);
    });

    it('should collect migrations from multiple sources', async () => {
      vi.mocked(fs.readdir).mockImplementation(async (path) => {
        if (String(path).includes('cms')) {
          return ['20240101000000__create_cms.sql'] as any;
        }
        if (String(path).includes('workflows')) {
          return ['20240102000000__create_workflows.sql'] as any;
        }
        return [] as any;
      });

      vi.mocked(fs.readFile).mockImplementation(async (path) => {
        if (String(path).includes('cms')) {
          return `-- up\nCREATE TABLE cms_content();\n-- down\nDROP TABLE cms_content;`;
        }
        return `-- up\nCREATE TABLE workflows();\n-- down\nDROP TABLE workflows;`;
      });

      const result = await collector.collect([
        { moduleName: 'cms', migrationsPath: '/modules/cms' },
        { moduleName: 'workflows', migrationsPath: '/modules/workflows' },
      ]);

      expect(result).toHaveLength(2);
      expect(result[0].moduleName).toBe('cms');
      expect(result[1].moduleName).toBe('workflows');
    });

    it('should order migrations by version', async () => {
      vi.mocked(fs.readdir).mockImplementation(async (path) => {
        if (String(path).includes('cms')) {
          return ['20240201000000__later.sql'] as any;
        }
        return ['20240101000000__earlier.sql'] as any;
      });

      vi.mocked(fs.readFile).mockResolvedValue(`-- up\nSELECT 1;\n-- down\nSELECT 2;`);

      const result = await collector.collect([
        { moduleName: 'cms', migrationsPath: '/modules/cms' },
        { moduleName: 'workflows', migrationsPath: '/modules/workflows' },
      ]);

      expect(result[0].version).toBe(20240101000000);
      expect(result[1].version).toBe(20240201000000);
    });

    it('should order migrations by module name when versions are equal', async () => {
      vi.mocked(fs.readdir).mockImplementation(async () => ['20240101000000__same.sql'] as any);
      vi.mocked(fs.readFile).mockResolvedValue(`-- up\nSELECT 1;\n-- down\nSELECT 2;`);

      const result = await collector.collect([
        { moduleName: 'workflows', migrationsPath: '/modules/workflows' },
        { moduleName: 'cms', migrationsPath: '/modules/cms' },
      ]);

      expect(result[0].moduleName).toBe('cms');
      expect(result[1].moduleName).toBe('workflows');
    });

    it('should parse up and down SQL sections', async () => {
      vi.mocked(fs.readdir).mockResolvedValueOnce(['20240101000000__test.sql'] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(`-- up
CREATE TABLE test (id INT);
INSERT INTO test VALUES (1);

-- down
DROP TABLE test;`);

      const result = await collector.collect([
        { moduleName: 'test', migrationsPath: '/modules/test' },
      ]);

      expect(result).toHaveLength(1);
      expect(result[0].up).toHaveLength(2);
      expect(result[0].up[0]).toBe('CREATE TABLE test (id INT)');
      expect(result[0].up[1]).toBe('INSERT INTO test VALUES (1)');
      expect(result[0].down).toHaveLength(1);
      expect(result[0].down[0]).toBe('DROP TABLE test');
    });

    it('should skip files without valid migration naming', async () => {
      vi.mocked(fs.readdir).mockResolvedValueOnce([
        '20240101000000__valid.sql',
        'README.md',
        '.gitkeep',
        'invalid_name.sql',
      ] as any);
      vi.mocked(fs.readFile).mockResolvedValue(`-- up\nSELECT 1;`);

      const result = await collector.collect([
        { moduleName: 'test', migrationsPath: '/modules/test' },
      ]);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('valid');
    });

    it('should skip migrations without up section', async () => {
      vi.mocked(fs.readdir).mockResolvedValueOnce(['20240101000000__empty.sql'] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(`-- This file has no up section`);

      const result = await collector.collect([
        { moduleName: 'test', migrationsPath: '/modules/test' },
      ]);

      expect(result).toHaveLength(0);
    });

    it('should handle empty directory', async () => {
      vi.mocked(fs.readdir).mockRejectedValueOnce(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      );

      const result = await collector.collect([
        { moduleName: 'test', migrationsPath: '/nonexistent' },
      ]);

      expect(result).toEqual([]);
    });

    it('should set moduleName on each migration', async () => {
      vi.mocked(fs.readdir).mockResolvedValueOnce(['20240101000000__test.sql'] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(`-- up\nSELECT 1;`);

      const result = await collector.collect([
        { moduleName: 'workflows', migrationsPath: '/modules/workflows' },
      ]);

      expect(result[0].moduleName).toBe('workflows');
    });

    it('should set scope to core by default', async () => {
      vi.mocked(fs.readdir).mockResolvedValueOnce(['20240101000000__test.sql'] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(`-- up\nSELECT 1;`);

      const result = await collector.collect([
        { moduleName: 'test', migrationsPath: '/modules/test' },
      ]);

      expect(result[0].scope).toBe('core');
    });
  });

  describe('SQL statement parsing', () => {
    it('should handle dollar-quoted strings', async () => {
      vi.mocked(fs.readdir).mockResolvedValueOnce(['20240101000000__func.sql'] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(`-- up
CREATE FUNCTION test() RETURNS void AS $$
BEGIN
  RAISE NOTICE 'test;';
END;
$$ LANGUAGE plpgsql;`);

      const result = await collector.collect([
        { moduleName: 'test', migrationsPath: '/modules/test' },
      ]);

      expect(result[0].up).toHaveLength(1);
      expect(result[0].up[0]).toContain('$$ LANGUAGE plpgsql');
    });

    it('should handle single-quoted strings with semicolons', async () => {
      vi.mocked(fs.readdir).mockResolvedValueOnce(['20240101000000__insert.sql'] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(`-- up
INSERT INTO test VALUES ('hello; world');`);

      const result = await collector.collect([
        { moduleName: 'test', migrationsPath: '/modules/test' },
      ]);

      expect(result[0].up).toHaveLength(1);
      expect(result[0].up[0]).toContain("'hello; world'");
    });

    it('should handle line comments', async () => {
      vi.mocked(fs.readdir).mockResolvedValueOnce(['20240101000000__comments.sql'] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(`-- up
CREATE TABLE test ( -- this is a comment with ;
  id INT
);`);

      const result = await collector.collect([
        { moduleName: 'test', migrationsPath: '/modules/test' },
      ]);

      expect(result[0].up).toHaveLength(1);
    });

    it('should handle block comments', async () => {
      vi.mocked(fs.readdir).mockResolvedValueOnce(['20240101000000__block.sql'] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(`-- up
CREATE TABLE test /* comment with ; inside */ (id INT);`);

      const result = await collector.collect([
        { moduleName: 'test', migrationsPath: '/modules/test' },
      ]);

      expect(result[0].up).toHaveLength(1);
    });
  });
});
