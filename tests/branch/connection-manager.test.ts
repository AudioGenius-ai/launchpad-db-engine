import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type BranchManager, createBranchManager } from '../../src/branch/branch-manager.js';
import {
  type ConnectionManager,
  createConnectionManager,
} from '../../src/branch/connection-manager.js';
import { createDriver } from '../../src/driver/index.js';
import type { Driver } from '../../src/driver/types.js';

const TEST_DB_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/launchpad_test';

describe('ConnectionManager', () => {
  let driver: Driver;
  let branchManager: BranchManager;
  let connectionManager: ConnectionManager;
  const createdBranches: string[] = [];

  beforeAll(async () => {
    driver = await createDriver({ connectionString: TEST_DB_URL });
    branchManager = createBranchManager({ driver });
    connectionManager = createConnectionManager({ driver });
    await branchManager.ensureMetadataTable();
  });

  afterAll(async () => {
    for (const slug of createdBranches) {
      try {
        await branchManager.deleteBranch(slug, true);
      } catch {}
    }
    await driver.close();
  });

  describe('switchToBranch', () => {
    it('should return correct connection info', async () => {
      const branch = await branchManager.createBranch({ name: 'conn-test' });
      createdBranches.push(branch.slug);

      const connection = await connectionManager.switchToBranch(branch.slug);

      expect(connection.schemaName).toBe(branch.schemaName);
      expect(connection.searchPath).toBe(`${branch.schemaName}, public`);
      expect(connection.connectionString).toContain(branch.schemaName);
    });

    it('should throw for non-existent branch', async () => {
      await expect(connectionManager.switchToBranch('non-existent')).rejects.toThrow(
        "Branch 'non-existent' not found"
      );
    });
  });

  describe('switchToMain', () => {
    it('should switch to main schema', async () => {
      const branch = await branchManager.createBranch({ name: 'main-switch-test' });
      createdBranches.push(branch.slug);

      await connectionManager.switchToBranch(branch.slug);
      const connection = await connectionManager.switchToMain();

      expect(connection.schemaName).toBe('public');
      expect(connection.searchPath).toBe('public, public');
    });
  });

  describe('withBranch', () => {
    it('should execute callback within branch context', async () => {
      const branch = await branchManager.createBranch({ name: 'with-branch-test' });
      createdBranches.push(branch.slug);

      await driver.execute(`CREATE TABLE ${branch.schemaName}.test_table (id SERIAL PRIMARY KEY)`);

      const result = await connectionManager.withBranch(branch.slug, async (client) => {
        const res = await client.query<{ tablename: string }>(`
          SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename = 'test_table'
        `);
        return res.rows.length > 0;
      });

      expect(result).toBe(true);
    });

    it('should isolate changes within transaction', async () => {
      const branch = await branchManager.createBranch({ name: 'isolation-test' });
      createdBranches.push(branch.slug);

      await expect(
        connectionManager.withBranch(branch.slug, async (client) => {
          await client.execute('CREATE TABLE test_rollback (id INT)');
          throw new Error('Intentional error');
        })
      ).rejects.toThrow('Intentional error');

      const result = await driver.query<{ exists: boolean }>(
        `
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = $1 AND table_name = 'test_rollback'
        ) as exists
      `,
        [branch.schemaName]
      );

      expect(result.rows[0].exists).toBe(false);
    });
  });

  describe('getCurrentSchema', () => {
    it('should return current schema after switch', async () => {
      const branch = await branchManager.createBranch({ name: 'current-schema-test' });
      createdBranches.push(branch.slug);

      await connectionManager.switchToBranch(branch.slug);

      expect(connectionManager.getCurrentSchema()).toBe(branch.schemaName);
    });

    it('should return main schema by default', () => {
      const freshManager = createConnectionManager({ driver });
      expect(freshManager.getCurrentSchema()).toBe('public');
    });
  });

  describe('validateSchema', () => {
    it('should return true for existing schema', async () => {
      const branch = await branchManager.createBranch({ name: 'validate-test' });
      createdBranches.push(branch.slug);

      const exists = await connectionManager.validateSchema(branch.schemaName);
      expect(exists).toBe(true);
    });

    it('should return false for non-existing schema', async () => {
      const exists = await connectionManager.validateSchema('non_existent_schema');
      expect(exists).toBe(false);
    });
  });

  describe('listAvailableSchemas', () => {
    it('should include branch schemas', async () => {
      const branch = await branchManager.createBranch({ name: 'list-schemas-test' });
      createdBranches.push(branch.slug);

      const schemas = await connectionManager.listAvailableSchemas();

      expect(schemas).toContain(branch.schemaName);
      expect(schemas).toContain('public');
    });
  });

  describe('generateConnectionString', () => {
    it('should generate valid connection string', () => {
      const connStr = connectionManager.generateConnectionString('branch_test');
      expect(connStr).toContain('search_path=branch_test,public');
    });
  });

  describe('generateEnvVars', () => {
    it('should generate environment variables', () => {
      const envVars = connectionManager.generateEnvVars('branch_test');

      expect(envVars.DATABASE_URL).toContain('branch_test');
      expect(envVars.DB_SCHEMA).toBe('branch_test');
      expect(envVars.DB_SEARCH_PATH).toBe('branch_test, public');
    });
  });
});
