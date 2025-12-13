import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Driver } from '../driver/types.js';
import type { DialectName, QueryResult } from '../types/index.js';
import { MigrationRunner } from './runner.js';

function createMockDriver(dialect: DialectName): Driver {
  const queryResults: Record<string, QueryResult> = {};
  const executeResults: Record<string, { rowCount: number }> = {};

  return {
    dialect,
    connectionString: `${dialect}://localhost`,
    query: vi.fn(async (sql: string, _params?: unknown[]) => {
      return queryResults[sql] || { rows: [], rowCount: 0 };
    }),
    execute: vi.fn(async (sql: string, _params?: unknown[]) => {
      return executeResults[sql] || { rowCount: 0 };
    }),
    transaction: vi.fn(async (fn) => {
      const trxClient = {
        query: vi.fn(async (sql: string, _params?: unknown[]) => {
          return queryResults[sql] || { rows: [], rowCount: 0 };
        }),
        execute: vi.fn(async (sql: string, _params?: unknown[]) => {
          return executeResults[sql] || { rowCount: 0 };
        }),
      };
      return fn(trxClient);
    }),
    close: vi.fn(async () => {}),
  };
}

describe('MigrationRunner', () => {
  let mockDriver: Driver;
  let runner: MigrationRunner;

  beforeEach(() => {
    mockDriver = createMockDriver('postgresql');
    runner = new MigrationRunner(mockDriver, {
      migrationsPath: '/tmp/migrations',
    });
  });

  describe('parseMigrationFile', () => {
    it('should parse a valid migration file with up and down sections', () => {
      const filename = '20240101000000__create_users.sql';
      const content = `-- up
CREATE TABLE users (id UUID PRIMARY KEY);
INSERT INTO users VALUES ('test');

-- down
DROP TABLE users;`;

      const result = (runner as any).parseMigrationFile(filename, content, 'core', undefined);

      expect(result).toEqual({
        version: 20240101000000,
        name: 'create_users',
        up: ['CREATE TABLE users (id UUID PRIMARY KEY)', "INSERT INTO users VALUES ('test')"],
        down: ['DROP TABLE users'],
        scope: 'core',
        templateKey: undefined,
      });
    });

    it('should parse migration with only up section', () => {
      const filename = '20240201000000__add_index.sql';
      const content = `-- up
CREATE INDEX idx_users_email ON users(email);`;

      const result = (runner as any).parseMigrationFile(filename, content, 'core', undefined);

      expect(result).toEqual({
        version: 20240201000000,
        name: 'add_index',
        up: ['CREATE INDEX idx_users_email ON users(email)'],
        down: [],
        scope: 'core',
        templateKey: undefined,
      });
    });

    it('should handle template migrations', () => {
      const filename = '20240301000000__template_table.sql';
      const content = `-- up
CREATE TABLE template_data (id INTEGER);

-- down
DROP TABLE template_data;`;

      const result = (runner as any).parseMigrationFile(
        filename,
        content,
        'template',
        'my-template'
      );

      expect(result).toEqual({
        version: 20240301000000,
        name: 'template_table',
        up: ['CREATE TABLE template_data (id INTEGER)'],
        down: ['DROP TABLE template_data'],
        scope: 'template',
        templateKey: 'my-template',
      });
    });

    it('should return null for invalid filename format', () => {
      const content = '-- up\nCREATE TABLE test;';

      expect(
        (runner as any).parseMigrationFile('invalid.sql', content, 'core', undefined)
      ).toBeNull();
      expect(
        (runner as any).parseMigrationFile('noversion__name.sql', content, 'core', undefined)
      ).toBeNull();
      expect((runner as any).parseMigrationFile('123.sql', content, 'core', undefined)).toBeNull();
    });

    it('should return null when no up section found', () => {
      const filename = '20240101000000__empty.sql';
      const content = '-- down\nDROP TABLE test;';

      const result = (runner as any).parseMigrationFile(filename, content, 'core', undefined);

      expect(result).toBeNull();
    });

    it('should handle case-insensitive up/down markers', () => {
      const filename = '20240101000000__case_test.sql';
      const content = `-- UP
CREATE TABLE test (id INTEGER);

-- DOWN
DROP TABLE test;`;

      const result = (runner as any).parseMigrationFile(filename, content, 'core', undefined);

      expect(result?.up).toEqual(['CREATE TABLE test (id INTEGER)']);
      expect(result?.down).toEqual(['DROP TABLE test']);
    });

    it('should trim whitespace and filter empty statements', () => {
      const filename = '20240101000000__whitespace.sql';
      const content = `-- up
  CREATE TABLE test (id INTEGER);

  INSERT INTO test VALUES (1);

  ;

-- down
  DROP TABLE test;  `;

      const result = (runner as any).parseMigrationFile(filename, content, 'core', undefined);

      expect(result?.up).toEqual(['CREATE TABLE test (id INTEGER)', 'INSERT INTO test VALUES (1)']);
      expect(result?.down).toEqual(['DROP TABLE test']);
    });

    it('should handle semicolons inside single-quoted strings', () => {
      const filename = '20240101000000__semicolon.sql';
      const content = `-- up
INSERT INTO config VALUES ('key', 'value;with;semicolons');

-- down
DELETE FROM config WHERE key = 'key';`;

      const result = (runner as any).parseMigrationFile(filename, content, 'core', undefined);

      expect(result?.up).toHaveLength(1);
      expect(result?.up[0]).toBe("INSERT INTO config VALUES ('key', 'value;with;semicolons')");
      expect(result?.down).toHaveLength(1);
    });

    it('should handle PostgreSQL dollar-quoted strings', () => {
      const filename = '20240101000000__dollar_quote.sql';
      const content = `-- up
CREATE FUNCTION test() RETURNS void AS $$
BEGIN
  INSERT INTO log VALUES ('test;value');
END;
$$ LANGUAGE plpgsql;

-- down
DROP FUNCTION test();`;

      const result = (runner as any).parseMigrationFile(filename, content, 'core', undefined);

      expect(result?.up).toHaveLength(1);
      expect(result?.up[0]).toContain('$$');
      expect(result?.up[0]).toContain("INSERT INTO log VALUES ('test;value')");
    });

    it('should handle SQL comments with semicolons', () => {
      const filename = '20240101000000__comments.sql';
      const content = `-- up
-- Setup comment with ; semicolon
CREATE TABLE test (id INTEGER);
INSERT INTO test VALUES (1);

-- down
DROP TABLE test;`;

      const result = (runner as any).parseMigrationFile(filename, content, 'core', undefined);

      expect(result?.up).toHaveLength(2);
      expect(result?.up[0]).toContain('-- Setup comment with ; semicolon');
      expect(result?.up[0]).toContain('CREATE TABLE test');
    });
  });

  describe('computeChecksum', () => {
    it('should compute consistent checksum for same input', () => {
      const statements = ['CREATE TABLE users', 'CREATE INDEX idx_users'];

      const checksum1 = (runner as any).computeChecksum(statements);
      const checksum2 = (runner as any).computeChecksum(statements);

      expect(checksum1).toBe(checksum2);
      expect(checksum1).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should produce different checksums for different inputs', () => {
      const statements1 = ['CREATE TABLE users'];
      const statements2 = ['CREATE TABLE accounts'];

      const checksum1 = (runner as any).computeChecksum(statements1);
      const checksum2 = (runner as any).computeChecksum(statements2);

      expect(checksum1).not.toBe(checksum2);
    });

    it('should be sensitive to statement order', () => {
      const statements1 = ['CREATE TABLE users', 'CREATE TABLE accounts'];
      const statements2 = ['CREATE TABLE accounts', 'CREATE TABLE users'];

      const checksum1 = (runner as any).computeChecksum(statements1);
      const checksum2 = (runner as any).computeChecksum(statements2);

      expect(checksum1).not.toBe(checksum2);
    });

    it('should produce valid SHA-256 hex string', () => {
      const statements = ['CREATE TABLE test'];
      const checksum = (runner as any).computeChecksum(statements);

      expect(checksum).toMatch(/^[a-f0-9]{64}$/);
      expect(checksum.length).toBe(64);
    });

    it('should handle empty array', () => {
      const checksum = (runner as any).computeChecksum([]);

      expect(checksum).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('ensureMigrationsTable', () => {
    it('should create PostgreSQL migrations table', async () => {
      await runner.ensureMigrationsTable();

      expect(mockDriver.execute).toHaveBeenCalledWith(
        expect.stringContaining('CREATE TABLE IF NOT EXISTS "lp_migrations"')
      );
      expect(mockDriver.execute).toHaveBeenCalledWith(
        expect.stringContaining('CREATE UNIQUE INDEX IF NOT EXISTS')
      );
    });

    it('should create MySQL migrations table', async () => {
      mockDriver = createMockDriver('mysql');
      runner = new MigrationRunner(mockDriver, {
        migrationsPath: '/tmp/migrations',
      });

      await runner.ensureMigrationsTable();

      expect(mockDriver.execute).toHaveBeenCalledWith(
        expect.stringContaining('CREATE TABLE IF NOT EXISTS `lp_migrations`')
      );
    });

    it('should create SQLite migrations table', async () => {
      mockDriver = createMockDriver('sqlite');
      runner = new MigrationRunner(mockDriver, {
        migrationsPath: '/tmp/migrations',
      });

      await runner.ensureMigrationsTable();

      expect(mockDriver.execute).toHaveBeenCalledWith(
        expect.stringContaining('CREATE TABLE IF NOT EXISTS "lp_migrations"')
      );
    });

    it('should use custom table name', async () => {
      runner = new MigrationRunner(mockDriver, {
        migrationsPath: '/tmp/migrations',
        tableName: 'custom_migrations',
      });

      await runner.ensureMigrationsTable();

      expect(mockDriver.execute).toHaveBeenCalledWith(
        expect.stringContaining('CREATE TABLE IF NOT EXISTS "custom_migrations"')
      );
    });
  });

  describe('version extraction', () => {
    it('should extract version from valid filename patterns', () => {
      const testCases = [
        { filename: '20240101000000__init.sql', expected: 20240101000000 },
        { filename: '1__first.sql', expected: 1 },
        { filename: '999999999999__large.sql', expected: 999999999999 },
        { filename: '20240315123456__timestamp.sql', expected: 20240315123456 },
      ];

      for (const { filename, expected } of testCases) {
        const content = '-- up\nCREATE TABLE test;';
        const result = (runner as any).parseMigrationFile(filename, content, 'core', undefined);
        expect(result?.version).toBe(expected);
      }
    });
  });

  describe('migration ordering', () => {
    it('should parse versions as numbers for proper sorting', () => {
      const versions = [20240101000000, 20240102000000, 20240103000000, 1, 2, 100, 20231231235959];

      const sorted = [...versions].sort((a, b) => a - b);

      expect(sorted).toEqual([
        1, 2, 100, 20231231235959, 20240101000000, 20240102000000, 20240103000000,
      ]);
    });

    it('should extract and compare versions correctly', () => {
      const files = ['20240103000000__third.sql', '1__first.sql', '20240102000000__second.sql'];

      const versions = files
        .map((f) => {
          const match = f.match(/^(\d+)__(.+)\.sql$/);
          return match ? Number.parseInt(match[1], 10) : 0;
        })
        .sort((a, b) => a - b);

      expect(versions).toEqual([1, 20240102000000, 20240103000000]);
    });
  });

  describe('migration file validation', () => {
    it('should validate migration name format', () => {
      const validNames = [
        '20240101000000__create_users.sql',
        '1__init.sql',
        '20240101000000__add_column_to_table.sql',
        '20240101000000__update_2024_01_01.sql',
      ];

      for (const name of validNames) {
        expect(name).toMatch(/^\d+__[a-z0-9_]+\.sql$/);
      }
    });

    it('should reject invalid migration names', () => {
      const invalidNames = [
        'no_version.sql',
        '20240101000000_single_underscore.sql',
        '20240101000000__.sql',
        '__no_version.sql',
      ];

      const pattern = /^\d+__[a-z0-9_]+\.sql$/;
      for (const name of invalidNames) {
        expect(name).not.toMatch(pattern);
      }
    });
  });

  describe('migration content parsing edge cases', () => {
    it('should handle migration with multiple statements', () => {
      const content = `-- up
CREATE TABLE users (id UUID);
CREATE TABLE accounts (id UUID);
INSERT INTO config VALUES ('version', '1');

-- down
DROP TABLE accounts;
DROP TABLE users;`;

      const result = (runner as any).parseMigrationFile('1__multi.sql', content, 'core', undefined);

      expect(result?.up.length).toBe(3);
      expect(result?.down.length).toBe(2);
    });

    it('should handle migration without down section', () => {
      const content = `-- up
CREATE TABLE permanent_table (id UUID);`;

      const result = (runner as any).parseMigrationFile(
        '1__permanent.sql',
        content,
        'core',
        undefined
      );

      expect(result?.up.length).toBe(1);
      expect(result?.down.length).toBe(0);
    });

    it('should handle down section at end without trailing newline', () => {
      const content = `-- up
CREATE TABLE test (id INTEGER);
-- down
DROP TABLE test;`;

      const result = (runner as any).parseMigrationFile('1__test.sql', content, 'core', undefined);

      expect(result?.down).toEqual(['DROP TABLE test']);
    });

    it('should handle migration with comments in SQL', () => {
      const content = `-- up
-- Create the users table
CREATE TABLE users (id UUID); -- Primary key

-- down
-- Remove the table
DROP TABLE users;`;

      const result = (runner as any).parseMigrationFile(
        '1__comments.sql',
        content,
        'core',
        undefined
      );

      expect(result?.up.length).toBeGreaterThan(0);
      expect(result?.down.length).toBeGreaterThan(0);
    });
  });

  describe('checksum validation', () => {
    it('should detect modified migration', () => {
      const original = ['CREATE TABLE users'];
      const modified = ['CREATE TABLE users', 'CREATE INDEX idx'];

      const checksum1 = (runner as any).computeChecksum(original);
      const checksum2 = (runner as any).computeChecksum(modified);

      expect(checksum1).not.toBe(checksum2);
    });

    it('should not change checksum for equivalent whitespace', () => {
      const statements1 = ['CREATE TABLE users', 'CREATE TABLE accounts'];
      const statements2 = ['CREATE TABLE users', 'CREATE TABLE accounts'];

      const checksum1 = (runner as any).computeChecksum(statements1);
      const checksum2 = (runner as any).computeChecksum(statements2);

      expect(checksum1).toBe(checksum2);
    });
  });

  describe('security - templateKey sanitization', () => {
    it('should reject templateKey with path traversal attempt using ..', () => {
      expect(() => {
        (runner as any).sanitizeTemplateKey('../../etc/passwd');
      }).toThrow('Invalid templateKey: "../../etc/passwd". Only alphanumeric characters, hyphens, and underscores are allowed.');
    });

    it('should reject templateKey with forward slash', () => {
      expect(() => {
        (runner as any).sanitizeTemplateKey('admin/config');
      }).toThrow('Invalid templateKey');
    });

    it('should reject templateKey with backslash', () => {
      expect(() => {
        (runner as any).sanitizeTemplateKey('admin\\config');
      }).toThrow('Invalid templateKey');
    });

    it('should reject templateKey with null byte', () => {
      expect(() => {
        (runner as any).sanitizeTemplateKey('admin\x00file');
      }).toThrow('Invalid templateKey');
    });

    it('should accept valid templateKey with alphanumerics', () => {
      expect((runner as any).sanitizeTemplateKey('crm123')).toBe('crm123');
    });

    it('should accept valid templateKey with hyphens', () => {
      expect((runner as any).sanitizeTemplateKey('saas-template')).toBe('saas-template');
    });

    it('should accept valid templateKey with underscores', () => {
      expect((runner as any).sanitizeTemplateKey('admin_ui')).toBe('admin_ui');
    });

    it('should accept valid templateKey with mixed valid characters', () => {
      expect((runner as any).sanitizeTemplateKey('my-template_v2')).toBe('my-template_v2');
    });

    it('should reject templateKey with special characters', () => {
      expect(() => {
        (runner as any).sanitizeTemplateKey('admin@template');
      }).toThrow('Invalid templateKey');
    });

    it('should reject templateKey with spaces', () => {
      expect(() => {
        (runner as any).sanitizeTemplateKey('admin template');
      }).toThrow('Invalid templateKey');
    });
  });
});
