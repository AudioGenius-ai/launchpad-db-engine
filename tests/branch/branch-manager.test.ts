import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type BranchManager, createBranchManager } from '../../src/branch/branch-manager.js';
import type { Branch } from '../../src/branch/types.js';
import { createDriver } from '../../src/driver/index.js';
import type { Driver } from '../../src/driver/types.js';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/launchpad_test';

describe('BranchManager', () => {
  let driver: Driver;
  let manager: BranchManager;
  const createdBranches: string[] = [];

  beforeAll(async () => {
    driver = await createDriver({ connectionString: TEST_DB_URL });
    manager = createBranchManager({ driver });
    await manager.ensureMetadataTable();
  });

  afterAll(async () => {
    for (const slug of createdBranches) {
      try {
        await manager.deleteBranch(slug, true);
      } catch {}
    }
    await driver.close();
  });

  afterEach(async () => {
    for (const slug of createdBranches) {
      try {
        await manager.deleteBranch(slug, true);
      } catch {}
    }
    createdBranches.length = 0;
  });

  describe('createBranch', () => {
    it('should create a branch with schema in under 5 seconds', async () => {
      const start = Date.now();

      const branch = await manager.createBranch({ name: 'test-feature' });
      createdBranches.push(branch.slug);

      const duration = Date.now() - start;

      expect(duration).toBeLessThan(5000);
      expect(branch.slug).toBe('test_feature');
      expect(branch.schemaName).toBe('branch_test_feature');
      expect(branch.status).toBe('active');
      expect(branch.isProtected).toBe(false);
    });

    it('should generate correct slug from name', async () => {
      const branch = await manager.createBranch({ name: 'Feature/New-Table' });
      createdBranches.push(branch.slug);

      expect(branch.slug).toBe('feature_new_table');
      expect(branch.schemaName).toBe('branch_feature_new_table');
    });

    it('should store git branch info', async () => {
      const branch = await manager.createBranch({
        name: 'pr-test',
        gitBranch: 'feature/user-auth',
        prNumber: 42,
        prUrl: 'https://github.com/org/repo/pull/42',
      });
      createdBranches.push(branch.slug);

      expect(branch.gitBranch).toBe('feature/user-auth');
      expect(branch.prNumber).toBe(42);
      expect(branch.prUrl).toBe('https://github.com/org/repo/pull/42');
    });

    it('should throw error if branch already exists', async () => {
      const branch = await manager.createBranch({ name: 'duplicate-test' });
      createdBranches.push(branch.slug);

      await expect(manager.createBranch({ name: 'duplicate-test' })).rejects.toThrow(
        "Branch 'duplicate_test' already exists"
      );
    });

    it('should set custom auto-delete days', async () => {
      const branch = await manager.createBranch({
        name: 'custom-delete',
        autoDeleteDays: 14,
      });
      createdBranches.push(branch.slug);

      expect(branch.autoDeleteDays).toBe(14);
    });
  });

  describe('getBranchBySlug', () => {
    it('should return branch by slug', async () => {
      const created = await manager.createBranch({ name: 'find-me' });
      createdBranches.push(created.slug);

      const found = await manager.getBranchBySlug('find_me');

      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
      expect(found!.name).toBe('find-me');
    });

    it('should return null for non-existent branch', async () => {
      const found = await manager.getBranchBySlug('non-existent-branch');
      expect(found).toBeNull();
    });
  });

  describe('deleteBranch', () => {
    it('should delete branch and schema', async () => {
      const branch = await manager.createBranch({ name: 'to-delete' });

      await manager.deleteBranch(branch.slug);

      const found = await manager.getBranchBySlug(branch.slug);
      expect(found).toBeNull();

      const schemaExists = await driver.query<{ exists: boolean }>(
        `
        SELECT EXISTS (
          SELECT 1 FROM information_schema.schemata
          WHERE schema_name = $1
        ) as exists
      `,
        [branch.schemaName]
      );
      expect(schemaExists.rows[0].exists).toBe(false);
    });

    it('should throw error for non-existent branch', async () => {
      await expect(manager.deleteBranch('non-existent')).rejects.toThrow(
        "Branch 'non-existent' not found"
      );
    });

    it('should not delete protected branch without force', async () => {
      const branch = await manager.createBranch({ name: 'protected-test' });
      createdBranches.push(branch.slug);

      await manager.protectBranch(branch.slug);

      await expect(manager.deleteBranch(branch.slug)).rejects.toThrow('is protected');
    });

    it('should delete protected branch with force', async () => {
      const branch = await manager.createBranch({ name: 'force-delete' });

      await manager.protectBranch(branch.slug);
      await manager.deleteBranch(branch.slug, true);

      const found = await manager.getBranchBySlug(branch.slug);
      expect(found).toBeNull();
    });
  });

  describe('switchBranch', () => {
    it('should return connection info for branch', async () => {
      const branch = await manager.createBranch({ name: 'switch-test' });
      createdBranches.push(branch.slug);

      const result = await manager.switchBranch(branch.slug);

      expect(result.schemaName).toBe(branch.schemaName);
      expect(result.searchPath).toBe(`${branch.schemaName}, public`);
      expect(result.connectionString).toContain(branch.schemaName);
    });

    it('should update last accessed timestamp', async () => {
      const branch = await manager.createBranch({ name: 'access-test' });
      createdBranches.push(branch.slug);

      const before = branch.lastAccessedAt;

      await new Promise((resolve) => setTimeout(resolve, 100));
      await manager.switchBranch(branch.slug);

      const updated = await manager.getBranchBySlug(branch.slug);
      expect(updated!.lastAccessedAt.getTime()).toBeGreaterThan(before.getTime());
    });
  });

  describe('listBranches', () => {
    it('should list all branches', async () => {
      const branch1 = await manager.createBranch({ name: 'list-test-1' });
      const branch2 = await manager.createBranch({ name: 'list-test-2' });
      createdBranches.push(branch1.slug, branch2.slug);

      const branches = await manager.listBranches();

      const slugs = branches.map((b) => b.slug);
      expect(slugs).toContain('list_test_1');
      expect(slugs).toContain('list_test_2');
    });

    it('should filter by status', async () => {
      const branch1 = await manager.createBranch({ name: 'status-test-1' });
      const branch2 = await manager.createBranch({ name: 'status-test-2' });
      createdBranches.push(branch1.slug, branch2.slug);

      await manager.protectBranch(branch2.slug);

      const activeBranches = await manager.listBranches({ status: 'active' });
      const protectedBranches = await manager.listBranches({ status: 'protected' });

      expect(activeBranches.some((b) => b.slug === 'status_test_1')).toBe(true);
      expect(activeBranches.some((b) => b.slug === 'status_test_2')).toBe(false);
      expect(protectedBranches.some((b) => b.slug === 'status_test_2')).toBe(true);
    });
  });

  describe('protectBranch / unprotectBranch', () => {
    it('should protect a branch', async () => {
      const branch = await manager.createBranch({ name: 'protect-test' });
      createdBranches.push(branch.slug);

      await manager.protectBranch(branch.slug);

      const updated = await manager.getBranchBySlug(branch.slug);
      expect(updated!.isProtected).toBe(true);
      expect(updated!.status).toBe('protected');
    });

    it('should unprotect a branch', async () => {
      const branch = await manager.createBranch({ name: 'unprotect-test' });
      createdBranches.push(branch.slug);

      await manager.protectBranch(branch.slug);
      await manager.unprotectBranch(branch.slug);

      const updated = await manager.getBranchBySlug(branch.slug);
      expect(updated!.isProtected).toBe(false);
      expect(updated!.status).toBe('active');
    });
  });

  describe('cleanupStaleBranches', () => {
    it('should delete branches inactive for N days', async () => {
      const branch = await manager.createBranch({ name: 'old-branch' });

      await driver.execute(
        `
        UPDATE lp_branch_metadata
        SET last_accessed_at = NOW() - INTERVAL '10 days'
        WHERE id = $1
      `,
        [branch.id]
      );

      const result = await manager.cleanupStaleBranches({ maxAgeDays: 7 });

      expect(result.deleted).toContain(branch.slug);
    });

    it('should skip protected branches', async () => {
      const branch = await manager.createBranch({ name: 'protected-old' });
      createdBranches.push(branch.slug);

      await manager.protectBranch(branch.slug);
      await driver.execute(
        `
        UPDATE lp_branch_metadata
        SET last_accessed_at = NOW() - INTERVAL '30 days'
        WHERE id = $1
      `,
        [branch.id]
      );

      const result = await manager.cleanupStaleBranches({ maxAgeDays: 7 });

      expect(result.deleted).not.toContain(branch.slug);
    });

    it('should support dry run', async () => {
      const branch = await manager.createBranch({ name: 'dry-run-test' });
      createdBranches.push(branch.slug);

      await driver.execute(
        `
        UPDATE lp_branch_metadata
        SET last_accessed_at = NOW() - INTERVAL '10 days'
        WHERE id = $1
      `,
        [branch.id]
      );

      const result = await manager.cleanupStaleBranches({
        maxAgeDays: 7,
        dryRun: true,
      });

      expect(result.deleted).toContain(branch.slug);

      const found = await manager.getBranchBySlug(branch.slug);
      expect(found).not.toBeNull();
    });
  });
});
