import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPostgresDriver } from '../../src/driver/postgresql.js';
import { MigrationRunner, createMigrationRunner } from '../../src/migrations/runner.js';
import type { Driver } from '../../src/driver/types.js';

const DATABASE_URL = process.env.DATABASE_URL;
const TEST_TIMEOUT = 30000;

describe.skipIf(!DATABASE_URL)('MigrationRunner E2E Tests', () => {
  let driver: Driver;
  let tempDir: string;
  let testTableName: string;

  beforeAll(async () => {
    if (!DATABASE_URL) return;
    driver = createPostgresDriver(DATABASE_URL);
  }, TEST_TIMEOUT);

  afterAll(async () => {
    if (driver) {
      await driver.close();
    }
  });

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'migration-e2e-'));
    await mkdir(join(tempDir, 'core'), { recursive: true });
    testTableName = `test_migrations_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  });

  afterEach(async () => {
    if (driver && testTableName) {
      try {
        await driver.execute(`DROP TABLE IF EXISTS "${testTableName}" CASCADE`);
        await driver.execute(`DROP TABLE IF EXISTS "e2e_test_table_${testTableName}" CASCADE`);
        await driver.execute(`DROP TABLE IF EXISTS "e2e_users_${testTableName}" CASCADE`);
        await driver.execute(`DROP TABLE IF EXISTS "e2e_accounts_${testTableName}" CASCADE`);
      } catch {
        // Ignore cleanup errors
      }
    }
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  describe('Migration Table Creation', () => {
    it('should create migrations tracking table on first run', async () => {
      const runner = createMigrationRunner(driver, {
        migrationsPath: tempDir,
        tableName: testTableName,
      });

      await runner.ensureMigrationsTable();

      const result = await driver.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_name = $1`,
        [testTableName]
      );

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].table_name).toBe(testTableName);
    }, TEST_TIMEOUT);

    it('should create table with correct columns', async () => {
      const runner = createMigrationRunner(driver, {
        migrationsPath: tempDir,
        tableName: testTableName,
      });

      await runner.ensureMigrationsTable();

      const result = await driver.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
        [testTableName]
      );

      const columns = result.rows.map((r) => r.column_name);
      expect(columns).toContain('version');
      expect(columns).toContain('name');
      expect(columns).toContain('scope');
      expect(columns).toContain('template_key');
      expect(columns).toContain('checksum');
      expect(columns).toContain('up_sql');
      expect(columns).toContain('down_sql');
      expect(columns).toContain('applied_at');
    }, TEST_TIMEOUT);

    it('should be idempotent - running multiple times does not error', async () => {
      const runner = createMigrationRunner(driver, {
        migrationsPath: tempDir,
        tableName: testTableName,
      });

      await runner.ensureMigrationsTable();
      await runner.ensureMigrationsTable();
      await runner.ensureMigrationsTable();

      const result = await driver.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM information_schema.tables WHERE table_name = $1`,
        [testTableName]
      );

      expect(result.rows[0].count).toBe('1');
    }, TEST_TIMEOUT);
  });

  describe('Running Migrations (up)', () => {
    it('should run a single migration from file', async () => {
      const tableName = `e2e_test_table_${testTableName}`;
      await writeFile(
        join(tempDir, 'core', '20240101000000__create_test_table.sql'),
        `-- up
CREATE TABLE "${tableName}" (id UUID PRIMARY KEY, name TEXT);

-- down
DROP TABLE "${tableName}";`
      );

      const runner = createMigrationRunner(driver, {
        migrationsPath: tempDir,
        tableName: testTableName,
      });

      const results = await runner.up();

      expect(results.length).toBe(1);
      expect(results[0].success).toBe(true);
      expect(results[0].version).toBe(20240101000000);
      expect(results[0].name).toBe('create_test_table');

      const tableExists = await driver.query<{ exists: boolean }>(
        `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1)`,
        [tableName]
      );
      expect(tableExists.rows[0].exists).toBe(true);
    }, TEST_TIMEOUT);

    it('should run multiple migrations in version order', async () => {
      const usersTable = `e2e_users_${testTableName}`;
      const accountsTable = `e2e_accounts_${testTableName}`;

      await writeFile(
        join(tempDir, 'core', '20240101000000__create_users.sql'),
        `-- up
CREATE TABLE "${usersTable}" (id UUID PRIMARY KEY);

-- down
DROP TABLE "${usersTable}";`
      );

      await writeFile(
        join(tempDir, 'core', '20240102000000__create_accounts.sql'),
        `-- up
CREATE TABLE "${accountsTable}" (id UUID PRIMARY KEY, user_id UUID);

-- down
DROP TABLE "${accountsTable}";`
      );

      const runner = createMigrationRunner(driver, {
        migrationsPath: tempDir,
        tableName: testTableName,
      });

      const results = await runner.up();

      expect(results.length).toBe(2);
      expect(results[0].version).toBe(20240101000000);
      expect(results[1].version).toBe(20240102000000);
      expect(results.every((r) => r.success)).toBe(true);
    }, TEST_TIMEOUT);

    it('should respect steps option', async () => {
      const usersTable = `e2e_users_${testTableName}`;
      const accountsTable = `e2e_accounts_${testTableName}`;

      await writeFile(
        join(tempDir, 'core', '20240101000000__create_users.sql'),
        `-- up
CREATE TABLE "${usersTable}" (id UUID PRIMARY KEY);

-- down
DROP TABLE "${usersTable}";`
      );

      await writeFile(
        join(tempDir, 'core', '20240102000000__create_accounts.sql'),
        `-- up
CREATE TABLE "${accountsTable}" (id UUID PRIMARY KEY);

-- down
DROP TABLE "${accountsTable}";`
      );

      const runner = createMigrationRunner(driver, {
        migrationsPath: tempDir,
        tableName: testTableName,
      });

      const results = await runner.up({ steps: 1 });

      expect(results.length).toBe(1);
      expect(results[0].version).toBe(20240101000000);

      const accountsExists = await driver.query<{ exists: boolean }>(
        `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1)`,
        [accountsTable]
      );
      expect(accountsExists.rows[0].exists).toBe(false);
    }, TEST_TIMEOUT);

    it('should respect toVersion option', async () => {
      const usersTable = `e2e_users_${testTableName}`;
      const accountsTable = `e2e_accounts_${testTableName}`;

      await writeFile(
        join(tempDir, 'core', '20240101000000__create_users.sql'),
        `-- up
CREATE TABLE "${usersTable}" (id UUID PRIMARY KEY);

-- down
DROP TABLE "${usersTable}";`
      );

      await writeFile(
        join(tempDir, 'core', '20240102000000__create_accounts.sql'),
        `-- up
CREATE TABLE "${accountsTable}" (id UUID PRIMARY KEY);

-- down
DROP TABLE "${accountsTable}";`
      );

      const runner = createMigrationRunner(driver, {
        migrationsPath: tempDir,
        tableName: testTableName,
      });

      const results = await runner.up({ toVersion: 20240101000000 });

      expect(results.length).toBe(1);
      expect(results[0].version).toBe(20240101000000);
    }, TEST_TIMEOUT);

    it('should skip already applied migrations', async () => {
      const usersTable = `e2e_users_${testTableName}`;

      await writeFile(
        join(tempDir, 'core', '20240101000000__create_users.sql'),
        `-- up
CREATE TABLE "${usersTable}" (id UUID PRIMARY KEY);

-- down
DROP TABLE "${usersTable}";`
      );

      const runner = createMigrationRunner(driver, {
        migrationsPath: tempDir,
        tableName: testTableName,
      });

      const firstRun = await runner.up();
      expect(firstRun.length).toBe(1);

      const secondRun = await runner.up();
      expect(secondRun.length).toBe(0);
    }, TEST_TIMEOUT);

    it('should stop on failed migration', async () => {
      const usersTable = `e2e_users_${testTableName}`;

      await writeFile(
        join(tempDir, 'core', '20240101000000__create_users.sql'),
        `-- up
CREATE TABLE "${usersTable}" (id UUID PRIMARY KEY);

-- down
DROP TABLE "${usersTable}";`
      );

      await writeFile(
        join(tempDir, 'core', '20240102000000__fail_migration.sql'),
        `-- up
INVALID SQL SYNTAX HERE;

-- down
SELECT 1;`
      );

      await writeFile(
        join(tempDir, 'core', '20240103000000__never_runs.sql'),
        `-- up
CREATE TABLE never_created (id UUID);

-- down
DROP TABLE never_created;`
      );

      const runner = createMigrationRunner(driver, {
        migrationsPath: tempDir,
        tableName: testTableName,
      });

      const results = await runner.up();

      expect(results.length).toBe(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(false);
      expect(results[1].error).toBeDefined();
    }, TEST_TIMEOUT);
  });

  describe('Rolling Back Migrations (down)', () => {
    it('should rollback a single migration', async () => {
      const usersTable = `e2e_users_${testTableName}`;

      await writeFile(
        join(tempDir, 'core', '20240101000000__create_users.sql'),
        `-- up
CREATE TABLE "${usersTable}" (id UUID PRIMARY KEY);

-- down
DROP TABLE "${usersTable}";`
      );

      const runner = createMigrationRunner(driver, {
        migrationsPath: tempDir,
        tableName: testTableName,
      });

      await runner.up();

      const tableExistsBefore = await driver.query<{ exists: boolean }>(
        `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1)`,
        [usersTable]
      );
      expect(tableExistsBefore.rows[0].exists).toBe(true);

      const results = await runner.down();

      expect(results.length).toBe(1);
      expect(results[0].success).toBe(true);

      const tableExistsAfter = await driver.query<{ exists: boolean }>(
        `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1)`,
        [usersTable]
      );
      expect(tableExistsAfter.rows[0].exists).toBe(false);
    }, TEST_TIMEOUT);

    it('should rollback migrations in reverse order', async () => {
      const usersTable = `e2e_users_${testTableName}`;
      const accountsTable = `e2e_accounts_${testTableName}`;

      await writeFile(
        join(tempDir, 'core', '20240101000000__create_users.sql'),
        `-- up
CREATE TABLE "${usersTable}" (id UUID PRIMARY KEY);

-- down
DROP TABLE "${usersTable}";`
      );

      await writeFile(
        join(tempDir, 'core', '20240102000000__create_accounts.sql'),
        `-- up
CREATE TABLE "${accountsTable}" (id UUID PRIMARY KEY);

-- down
DROP TABLE "${accountsTable}";`
      );

      const runner = createMigrationRunner(driver, {
        migrationsPath: tempDir,
        tableName: testTableName,
      });

      await runner.up();
      const results = await runner.down();

      expect(results.length).toBe(2);
      expect(results[0].version).toBe(20240102000000);
      expect(results[1].version).toBe(20240101000000);
    }, TEST_TIMEOUT);

    it('should respect steps option for rollback', async () => {
      const usersTable = `e2e_users_${testTableName}`;
      const accountsTable = `e2e_accounts_${testTableName}`;

      await writeFile(
        join(tempDir, 'core', '20240101000000__create_users.sql'),
        `-- up
CREATE TABLE "${usersTable}" (id UUID PRIMARY KEY);

-- down
DROP TABLE "${usersTable}";`
      );

      await writeFile(
        join(tempDir, 'core', '20240102000000__create_accounts.sql'),
        `-- up
CREATE TABLE "${accountsTable}" (id UUID PRIMARY KEY);

-- down
DROP TABLE "${accountsTable}";`
      );

      const runner = createMigrationRunner(driver, {
        migrationsPath: tempDir,
        tableName: testTableName,
      });

      await runner.up();
      const results = await runner.down({ steps: 1 });

      expect(results.length).toBe(1);
      expect(results[0].version).toBe(20240102000000);

      const usersExists = await driver.query<{ exists: boolean }>(
        `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1)`,
        [usersTable]
      );
      expect(usersExists.rows[0].exists).toBe(true);
    }, TEST_TIMEOUT);

    it('should fail gracefully when no down migration exists', async () => {
      const usersTable = `e2e_users_${testTableName}`;

      await writeFile(
        join(tempDir, 'core', '20240101000000__create_users.sql'),
        `-- up
CREATE TABLE "${usersTable}" (id UUID PRIMARY KEY);`
      );

      const runner = createMigrationRunner(driver, {
        migrationsPath: tempDir,
        tableName: testTableName,
      });

      await runner.up();
      const results = await runner.down();

      expect(results.length).toBe(1);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('No down migration available');
    }, TEST_TIMEOUT);
  });

  describe('Migration State Tracking', () => {
    it('should record applied migrations with metadata', async () => {
      const usersTable = `e2e_users_${testTableName}`;

      await writeFile(
        join(tempDir, 'core', '20240101000000__create_users.sql'),
        `-- up
CREATE TABLE "${usersTable}" (id UUID PRIMARY KEY);

-- down
DROP TABLE "${usersTable}";`
      );

      const runner = createMigrationRunner(driver, {
        migrationsPath: tempDir,
        tableName: testTableName,
      });

      await runner.up();

      const record = await driver.query<{
        version: string;
        name: string;
        scope: string;
        checksum: string;
        applied_at: Date;
      }>(`SELECT version, name, scope, checksum, applied_at FROM "${testTableName}"`);

      expect(record.rows.length).toBe(1);
      expect(record.rows[0].version).toBe('20240101000000');
      expect(record.rows[0].name).toBe('create_users');
      expect(record.rows[0].scope).toBe('core');
      expect(record.rows[0].checksum).toMatch(/^[a-f0-9]{64}$/);
      expect(record.rows[0].applied_at).toBeInstanceOf(Date);
    }, TEST_TIMEOUT);

    it('should store up and down SQL in migration record', async () => {
      const usersTable = `e2e_users_${testTableName}`;

      await writeFile(
        join(tempDir, 'core', '20240101000000__create_users.sql'),
        `-- up
CREATE TABLE "${usersTable}" (id UUID PRIMARY KEY);

-- down
DROP TABLE "${usersTable}";`
      );

      const runner = createMigrationRunner(driver, {
        migrationsPath: tempDir,
        tableName: testTableName,
      });

      await runner.up();

      const record = await driver.query<{
        up_sql: string[];
        down_sql: string[];
      }>(`SELECT up_sql, down_sql FROM "${testTableName}"`);

      expect(record.rows[0].up_sql.length).toBeGreaterThan(0);
      expect(record.rows[0].down_sql.length).toBeGreaterThan(0);
    }, TEST_TIMEOUT);

    it('should remove migration record on rollback', async () => {
      const usersTable = `e2e_users_${testTableName}`;

      await writeFile(
        join(tempDir, 'core', '20240101000000__create_users.sql'),
        `-- up
CREATE TABLE "${usersTable}" (id UUID PRIMARY KEY);

-- down
DROP TABLE "${usersTable}";`
      );

      const runner = createMigrationRunner(driver, {
        migrationsPath: tempDir,
        tableName: testTableName,
      });

      await runner.up();

      const beforeRollback = await driver.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM "${testTableName}"`
      );
      expect(beforeRollback.rows[0].count).toBe('1');

      await runner.down();

      const afterRollback = await driver.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM "${testTableName}"`
      );
      expect(afterRollback.rows[0].count).toBe('0');
    }, TEST_TIMEOUT);
  });

  describe('Migration Status', () => {
    it('should report pending migrations', async () => {
      const usersTable = `e2e_users_${testTableName}`;

      await writeFile(
        join(tempDir, 'core', '20240101000000__create_users.sql'),
        `-- up
CREATE TABLE "${usersTable}" (id UUID PRIMARY KEY);

-- down
DROP TABLE "${usersTable}";`
      );

      const runner = createMigrationRunner(driver, {
        migrationsPath: tempDir,
        tableName: testTableName,
      });

      const status = await runner.status();

      expect(status.applied.length).toBe(0);
      expect(status.pending.length).toBe(1);
      expect(status.current).toBeNull();
    }, TEST_TIMEOUT);

    it('should report applied migrations', async () => {
      const usersTable = `e2e_users_${testTableName}`;

      await writeFile(
        join(tempDir, 'core', '20240101000000__create_users.sql'),
        `-- up
CREATE TABLE "${usersTable}" (id UUID PRIMARY KEY);

-- down
DROP TABLE "${usersTable}";`
      );

      const runner = createMigrationRunner(driver, {
        migrationsPath: tempDir,
        tableName: testTableName,
      });

      await runner.up();
      const status = await runner.status();

      expect(status.applied.length).toBe(1);
      expect(status.pending.length).toBe(0);
      expect(status.current).toBe(20240101000000);
    }, TEST_TIMEOUT);

    it('should report mixed state correctly', async () => {
      const usersTable = `e2e_users_${testTableName}`;
      const accountsTable = `e2e_accounts_${testTableName}`;

      await writeFile(
        join(tempDir, 'core', '20240101000000__create_users.sql'),
        `-- up
CREATE TABLE "${usersTable}" (id UUID PRIMARY KEY);

-- down
DROP TABLE "${usersTable}";`
      );

      const runner = createMigrationRunner(driver, {
        migrationsPath: tempDir,
        tableName: testTableName,
      });

      await runner.up();

      await writeFile(
        join(tempDir, 'core', '20240102000000__create_accounts.sql'),
        `-- up
CREATE TABLE "${accountsTable}" (id UUID PRIMARY KEY);

-- down
DROP TABLE "${accountsTable}";`
      );

      const status = await runner.status();

      expect(status.applied.length).toBe(1);
      expect(status.pending.length).toBe(1);
      expect(status.current).toBe(20240101000000);
    }, TEST_TIMEOUT);
  });

  describe('Migration Verification', () => {
    it('should verify migrations with matching checksums', async () => {
      const usersTable = `e2e_users_${testTableName}`;

      await writeFile(
        join(tempDir, 'core', '20240101000000__create_users.sql'),
        `-- up
CREATE TABLE "${usersTable}" (id UUID PRIMARY KEY);

-- down
DROP TABLE "${usersTable}";`
      );

      const runner = createMigrationRunner(driver, {
        migrationsPath: tempDir,
        tableName: testTableName,
      });

      await runner.up();
      const verification = await runner.verify();

      expect(verification.valid).toBe(true);
      expect(verification.issues.length).toBe(0);
    }, TEST_TIMEOUT);

    it('should detect modified migration files', async () => {
      const usersTable = `e2e_users_${testTableName}`;
      const migrationPath = join(tempDir, 'core', '20240101000000__create_users.sql');

      await writeFile(
        migrationPath,
        `-- up
CREATE TABLE "${usersTable}" (id UUID PRIMARY KEY);

-- down
DROP TABLE "${usersTable}";`
      );

      const runner = createMigrationRunner(driver, {
        migrationsPath: tempDir,
        tableName: testTableName,
      });

      await runner.up();

      await writeFile(
        migrationPath,
        `-- up
CREATE TABLE "${usersTable}" (id UUID PRIMARY KEY, name TEXT);

-- down
DROP TABLE "${usersTable}";`
      );

      const verification = await runner.verify();

      expect(verification.valid).toBe(false);
      expect(verification.issues.length).toBe(1);
      expect(verification.issues[0]).toContain('checksum mismatch');
    }, TEST_TIMEOUT);

    it('should detect missing migration files', async () => {
      const usersTable = `e2e_users_${testTableName}`;
      const migrationPath = join(tempDir, 'core', '20240101000000__create_users.sql');

      await writeFile(
        migrationPath,
        `-- up
CREATE TABLE "${usersTable}" (id UUID PRIMARY KEY);

-- down
DROP TABLE "${usersTable}";`
      );

      const runner = createMigrationRunner(driver, {
        migrationsPath: tempDir,
        tableName: testTableName,
      });

      await runner.up();
      await rm(migrationPath);

      const verification = await runner.verify();

      expect(verification.valid).toBe(false);
      expect(verification.issues.length).toBe(1);
      expect(verification.issues[0]).toContain('file is missing');
    }, TEST_TIMEOUT);
  });

  describe('Dry Run Mode', () => {
    it('should not apply migrations in dry run mode', async () => {
      const usersTable = `e2e_users_${testTableName}`;

      await writeFile(
        join(tempDir, 'core', '20240101000000__create_users.sql'),
        `-- up
CREATE TABLE "${usersTable}" (id UUID PRIMARY KEY);

-- down
DROP TABLE "${usersTable}";`
      );

      const runner = createMigrationRunner(driver, {
        migrationsPath: tempDir,
        tableName: testTableName,
      });

      const results = await runner.up({ dryRun: true });

      expect(results.length).toBe(1);
      expect(results[0].success).toBe(true);

      const tableExists = await driver.query<{ exists: boolean }>(
        `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1)`,
        [usersTable]
      );
      expect(tableExists.rows[0].exists).toBe(false);
    }, TEST_TIMEOUT);

    it('should not rollback migrations in dry run mode', async () => {
      const usersTable = `e2e_users_${testTableName}`;

      await writeFile(
        join(tempDir, 'core', '20240101000000__create_users.sql'),
        `-- up
CREATE TABLE "${usersTable}" (id UUID PRIMARY KEY);

-- down
DROP TABLE "${usersTable}";`
      );

      const runner = createMigrationRunner(driver, {
        migrationsPath: tempDir,
        tableName: testTableName,
      });

      await runner.up();
      const results = await runner.down({ dryRun: true });

      expect(results.length).toBe(1);
      expect(results[0].success).toBe(true);

      const tableExists = await driver.query<{ exists: boolean }>(
        `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1)`,
        [usersTable]
      );
      expect(tableExists.rows[0].exists).toBe(true);
    }, TEST_TIMEOUT);
  });

  describe('Transaction Safety', () => {
    it('should rollback failed migration atomically', async () => {
      const usersTable = `e2e_users_${testTableName}`;

      await writeFile(
        join(tempDir, 'core', '20240101000000__create_and_fail.sql'),
        `-- up
CREATE TABLE "${usersTable}" (id UUID PRIMARY KEY);
INVALID SQL SYNTAX;

-- down
DROP TABLE "${usersTable}";`
      );

      const runner = createMigrationRunner(driver, {
        migrationsPath: tempDir,
        tableName: testTableName,
      });

      const results = await runner.up();

      expect(results.length).toBe(1);
      expect(results[0].success).toBe(false);

      const tableExists = await driver.query<{ exists: boolean }>(
        `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1)`,
        [usersTable]
      );
      expect(tableExists.rows[0].exists).toBe(false);

      const migrationRecorded = await driver.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM "${testTableName}" WHERE version = 20240101000000`
      );
      expect(migrationRecorded.rows[0].count).toBe('0');
    }, TEST_TIMEOUT);
  });

  describe('Template Migrations', () => {
    it('should run template-specific migrations', async () => {
      const templateTable = `e2e_template_${testTableName}`;
      await mkdir(join(tempDir, 'templates', 'crm'), { recursive: true });

      await writeFile(
        join(tempDir, 'templates', 'crm', '20240101000000__crm_contacts.sql'),
        `-- up
CREATE TABLE "${templateTable}" (id UUID PRIMARY KEY);

-- down
DROP TABLE "${templateTable}";`
      );

      const runner = createMigrationRunner(driver, {
        migrationsPath: tempDir,
        tableName: testTableName,
      });

      const results = await runner.up({ scope: 'template', templateKey: 'crm' });

      expect(results.length).toBe(1);
      expect(results[0].success).toBe(true);

      const status = await runner.status({ scope: 'template', templateKey: 'crm' });
      expect(status.applied.length).toBe(1);
      expect(status.applied[0].templateKey).toBe('crm');
    }, TEST_TIMEOUT);

    it('should isolate template migrations from core', async () => {
      const coreTable = `e2e_core_${testTableName}`;
      const templateTable = `e2e_template_${testTableName}`;

      await writeFile(
        join(tempDir, 'core', '20240101000000__core_table.sql'),
        `-- up
CREATE TABLE "${coreTable}" (id UUID PRIMARY KEY);

-- down
DROP TABLE "${coreTable}";`
      );

      await mkdir(join(tempDir, 'templates', 'crm'), { recursive: true });
      await writeFile(
        join(tempDir, 'templates', 'crm', '20240101000000__crm_table.sql'),
        `-- up
CREATE TABLE "${templateTable}" (id UUID PRIMARY KEY);

-- down
DROP TABLE "${templateTable}";`
      );

      const runner = createMigrationRunner(driver, {
        migrationsPath: tempDir,
        tableName: testTableName,
      });

      await runner.up({ scope: 'core' });
      const coreStatus = await runner.status({ scope: 'core' });
      const templateStatus = await runner.status({ scope: 'template', templateKey: 'crm' });

      expect(coreStatus.applied.length).toBe(1);
      expect(templateStatus.pending.length).toBe(1);
    }, TEST_TIMEOUT);
  });

  describe('Edge Cases', () => {
    it('should handle empty migrations directory', async () => {
      const runner = createMigrationRunner(driver, {
        migrationsPath: tempDir,
        tableName: testTableName,
      });

      const results = await runner.up();
      expect(results.length).toBe(0);

      const status = await runner.status();
      expect(status.applied.length).toBe(0);
      expect(status.pending.length).toBe(0);
    }, TEST_TIMEOUT);

    it('should handle non-existent migrations directory gracefully', async () => {
      const runner = createMigrationRunner(driver, {
        migrationsPath: '/non/existent/path',
        tableName: testTableName,
      });

      const results = await runner.up();
      expect(results.length).toBe(0);
    }, TEST_TIMEOUT);

    it('should ignore non-SQL files in migrations directory', async () => {
      await writeFile(join(tempDir, 'core', 'README.md'), '# Migrations');
      await writeFile(join(tempDir, 'core', '.gitkeep'), '');

      const runner = createMigrationRunner(driver, {
        migrationsPath: tempDir,
        tableName: testTableName,
      });

      const status = await runner.status();
      expect(status.pending.length).toBe(0);
    }, TEST_TIMEOUT);

    it('should handle migration with multiple statements correctly', async () => {
      const usersTable = `e2e_users_${testTableName}`;

      await writeFile(
        join(tempDir, 'core', '20240101000000__multi_statement.sql'),
        `-- up
CREATE TABLE "${usersTable}" (id UUID PRIMARY KEY, name TEXT);
CREATE INDEX "idx_${usersTable}_name" ON "${usersTable}"(name);
INSERT INTO "${usersTable}" (id, name) VALUES ('00000000-0000-0000-0000-000000000001', 'Test');

-- down
DROP TABLE "${usersTable}";`
      );

      const runner = createMigrationRunner(driver, {
        migrationsPath: tempDir,
        tableName: testTableName,
      });

      const results = await runner.up();
      expect(results[0].success).toBe(true);

      const data = await driver.query<{ name: string }>(
        `SELECT name FROM "${usersTable}"`
      );
      expect(data.rows[0].name).toBe('Test');
    }, TEST_TIMEOUT);
  });
});
