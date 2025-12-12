import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDbClient } from '../../src/client.js';
import type { DbClient } from '../../src/client.js';
import { createPostgresDriver } from '../../src/driver/postgresql.js';
import type { Driver } from '../../src/driver/types.js';

describe.skipIf(!process.env.DATABASE_URL)('Multi-Tenancy E2E Tests', () => {
  let driver: Driver;
  let db: DbClient;
  const testTableName = 'e2e_multi_tenant_test';

  // Test data
  const tenant1 = {
    appId: 'app-tenant-1',
    organizationId: 'org-tenant-1',
  };

  const tenant2 = {
    appId: 'app-tenant-2',
    organizationId: 'org-tenant-2',
  };

  beforeAll(async () => {
    driver = createPostgresDriver({
      connectionString: process.env.DATABASE_URL as string,
    });

    db = createDbClient(driver, {
      tenantColumns: {
        appId: 'app_id',
        organizationId: 'organization_id',
      },
    });

    // Create test table with tenant columns
    await driver.execute(`
      DROP TABLE IF EXISTS ${testTableName};
      CREATE TABLE ${testTableName} (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL,
        app_id VARCHAR(255) NOT NULL,
        organization_id VARCHAR(255) NOT NULL,
        secret_data TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(app_id, organization_id, email)
      );

      CREATE INDEX idx_${testTableName}_tenant ON ${testTableName}(app_id, organization_id);
    `);
  });

  afterAll(async () => {
    await driver.execute(`DROP TABLE IF EXISTS ${testTableName};`);
    await driver.close();
  });

  beforeEach(async () => {
    // Clear data before each test
    await driver.execute(`DELETE FROM ${testTableName};`);
  });

  describe('Tenant Context Injection in Queries', () => {
    it('should inject tenant columns in WHERE clauses during select', async () => {
      // Insert test data for both tenants
      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, app_id, organization_id, secret_data)
         VALUES ($1, $2, $3, $4, $5)`,
        ['User1', 'user1@tenant1.com', tenant1.appId, tenant1.organizationId, 'secret1']
      );

      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, app_id, organization_id, secret_data)
         VALUES ($1, $2, $3, $4, $5)`,
        ['User2', 'user2@tenant2.com', tenant2.appId, tenant2.organizationId, 'secret2']
      );

      // Query with tenant1 context - should only get tenant1 data
      const result = await db.table(testTableName, tenant1).select().execute();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        name: 'User1',
        email: 'user1@tenant1.com',
        app_id: tenant1.appId,
        organization_id: tenant1.organizationId,
      });
    });

    it('should inject app_id column in WHERE clause', async () => {
      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, app_id, organization_id, secret_data)
         VALUES ($1, $2, $3, $4, $5)`,
        ['User1', 'user1@example.com', tenant1.appId, tenant1.organizationId, 'secret1']
      );

      const result = await db.table(testTableName, tenant1).select().execute();

      expect(result).toHaveLength(1);
      expect(result[0].app_id).toBe(tenant1.appId);
    });

    it('should inject organization_id column in WHERE clause', async () => {
      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, app_id, organization_id, secret_data)
         VALUES ($1, $2, $3, $4, $5)`,
        ['User1', 'user1@example.com', tenant1.appId, tenant1.organizationId, 'secret1']
      );

      const result = await db.table(testTableName, tenant1).select().execute();

      expect(result).toHaveLength(1);
      expect(result[0].organization_id).toBe(tenant1.organizationId);
    });
  });

  describe('SET LOCAL PostgreSQL Session Variables', () => {
    it('should set app.current_app_id during transaction', async () => {
      let sessionAppId: string | null = null;

      await db.transaction(tenant1, async (trx) => {
        const result = await trx.raw<{ current_setting: string }>(
          `SELECT current_setting('app.current_app_id', true) as current_setting`
        );
        sessionAppId = result.rows[0]?.current_setting || null;
      });

      expect(sessionAppId).toBe(tenant1.appId);
    });

    it('should set app.current_org_id during transaction', async () => {
      let sessionOrgId: string | null = null;

      await db.transaction(tenant1, async (trx) => {
        const result = await trx.raw<{ current_setting: string }>(
          `SELECT current_setting('app.current_org_id', true) as current_setting`
        );
        sessionOrgId = result.rows[0]?.current_setting || null;
      });

      expect(sessionOrgId).toBe(tenant1.organizationId);
    });

    it('should isolate session variables between transactions', async () => {
      const appIds: string[] = [];

      // Transaction 1
      await db.transaction(tenant1, async (trx) => {
        const result = await trx.raw<{ current_setting: string }>(
          `SELECT current_setting('app.current_app_id', true) as current_setting`
        );
        appIds.push(result.rows[0]?.current_setting || '');
      });

      // Transaction 2
      await db.transaction(tenant2, async (trx) => {
        const result = await trx.raw<{ current_setting: string }>(
          `SELECT current_setting('app.current_app_id', true) as current_setting`
        );
        appIds.push(result.rows[0]?.current_setting || '');
      });

      expect(appIds).toEqual([tenant1.appId, tenant2.appId]);
    });
  });

  describe('Cross-Tenant Query Prevention', () => {
    it('should prevent cross-tenant data access in queries', async () => {
      // Insert data for both tenants (let PostgreSQL generate UUIDs)
      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, app_id, organization_id, secret_data)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          'User1',
          'user1@cross.com',
          tenant1.appId,
          tenant1.organizationId,
          'secret-data-1',
        ]
      );

      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, app_id, organization_id, secret_data)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          'User2',
          'user2@cross.com',
          tenant2.appId,
          tenant2.organizationId,
          'secret-data-2',
        ]
      );

      // Query tenant1 - should not see tenant2 data
      const tenant1Result = await db.table(testTableName, tenant1).select().execute();
      expect(tenant1Result).toHaveLength(1);
      expect(tenant1Result[0].name).toBe('User1');

      // Query tenant2 - should not see tenant1 data
      const tenant2Result = await db.table(testTableName, tenant2).select().execute();
      expect(tenant2Result).toHaveLength(1);
      expect(tenant2Result[0].name).toBe('User2');
    });

    it('should return only tenant-specific data when querying by name', async () => {
      // Insert data with unique names per tenant (avoid ID conflicts)
      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, app_id, organization_id, secret_data)
         VALUES ($1, $2, $3, $4, $5)`,
        ['SharedUser', 'user1@example.com', tenant1.appId, tenant1.organizationId, 'secret-1']
      );

      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, app_id, organization_id, secret_data)
         VALUES ($1, $2, $3, $4, $5)`,
        ['SharedUser', 'user2@example.com', tenant2.appId, tenant2.organizationId, 'secret-2']
      );

      // Tenant1 queries by name - should only get tenant1's version
      const result = await db
        .table(testTableName, tenant1)
        .where('name', '=', 'SharedUser')
        .select()
        .execute();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        name: 'SharedUser',
        app_id: tenant1.appId,
        organization_id: tenant1.organizationId,
      });
    });

    it('should prevent UPDATE across tenant boundaries', async () => {
      // Insert data for both tenants
      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, app_id, organization_id, secret_data)
         VALUES ($1, $2, $3, $4, $5)`,
        ['User1', 'user1@update.com', tenant1.appId, tenant1.organizationId, 'secret-1']
      );

      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, app_id, organization_id, secret_data)
         VALUES ($1, $2, $3, $4, $5)`,
        ['User2', 'user2@update.com', tenant2.appId, tenant2.organizationId, 'secret-2']
      );

      // Tenant1 tries to update by name (with tenant context injection)
      await db
        .table(testTableName, tenant1)
        .where('email', '=', 'user1@update.com')
        .update({ name: 'Updated User1' })
        .execute();

      // Verify tenant1 data was updated
      const tenant1Data = await driver.query<{ name: string }>(
        `SELECT name FROM ${testTableName} WHERE email = $1 AND app_id = $2`,
        ['user1@update.com', tenant1.appId]
      );
      expect(tenant1Data.rows[0].name).toBe('Updated User1');

      // Verify tenant2 data was NOT updated
      const tenant2Data = await driver.query<{ name: string }>(
        `SELECT name FROM ${testTableName} WHERE email = $1 AND app_id = $2`,
        ['user2@update.com', tenant2.appId]
      );
      expect(tenant2Data.rows[0].name).toBe('User2');
    });

    it('should prevent DELETE across tenant boundaries', async () => {
      // Insert data for both tenants
      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, app_id, organization_id, secret_data)
         VALUES ($1, $2, $3, $4, $5)`,
        ['User1', 'user1@delete.com', tenant1.appId, tenant1.organizationId, 'secret-1']
      );

      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, app_id, organization_id, secret_data)
         VALUES ($1, $2, $3, $4, $5)`,
        ['User2', 'user2@delete.com', tenant2.appId, tenant2.organizationId, 'secret-2']
      );

      // Tenant1 tries to delete by email (with tenant context injection)
      await db
        .table(testTableName, tenant1)
        .where('email', '=', 'user1@delete.com')
        .delete()
        .execute();

      // Verify tenant1 data was deleted
      const tenant1Count = await driver.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM ${testTableName} WHERE email = $1 AND app_id = $2`,
        ['user1@delete.com', tenant1.appId]
      );
      expect(Number(tenant1Count.rows[0].count)).toBe(0);

      // Verify tenant2 data still exists
      const tenant2Count = await driver.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM ${testTableName} WHERE email = $1 AND app_id = $2`,
        ['user2@delete.com', tenant2.appId]
      );
      expect(Number(tenant2Count.rows[0].count)).toBe(1);
    });
  });

  describe('Tenant Context in Transactions', () => {
    it('should persist tenant context within transaction', async () => {
      const contexts: Array<{ appId: string; orgId: string }> = [];

      await db.transaction(tenant1, async (trx) => {
        // First query
        const result1 = await trx.raw<{ app: string; org: string }>(
          `SELECT current_setting('app.current_app_id', true) as app,
                  current_setting('app.current_org_id', true) as org`
        );
        contexts.push({
          appId: result1.rows[0].app,
          orgId: result1.rows[0].org,
        });

        // Second query
        const result2 = await trx.raw<{ app: string; org: string }>(
          `SELECT current_setting('app.current_app_id', true) as app,
                  current_setting('app.current_org_id', true) as org`
        );
        contexts.push({
          appId: result2.rows[0].app,
          orgId: result2.rows[0].org,
        });
      });

      // Context should be consistent throughout transaction
      expect(contexts).toHaveLength(2);
      expect(contexts[0]).toEqual(contexts[1]);
      expect(contexts[0]).toEqual({
        appId: tenant1.appId,
        orgId: tenant1.organizationId,
      });
    });

    it('should maintain tenant isolation in nested queries within transaction', async () => {
      // Insert data for both tenants (let database generate UUIDs)
      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, app_id, organization_id, secret_data)
         VALUES ($1, $2, $3, $4, $5)`,
        ['User1', 'user1@trx.com', tenant1.appId, tenant1.organizationId, 'secret-1']
      );

      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, app_id, organization_id, secret_data)
         VALUES ($1, $2, $3, $4, $5)`,
        ['User2', 'user2@trx.com', tenant2.appId, tenant2.organizationId, 'secret-2']
      );

      let recordCount = 0;

      // Query within transaction
      await db.transaction(tenant1, async (trx) => {
        const result = await trx.table(testTableName).select().execute();
        recordCount = result.length;
      });

      expect(recordCount).toBe(1);
    });

    it('should handle multiple sequential transactions with different contexts', async () => {
      const results: string[] = [];

      // Transaction 1 - Tenant1
      await db.transaction(tenant1, async (trx) => {
        await trx.execute(
          `INSERT INTO ${testTableName} (name, email, app_id, organization_id, secret_data)
           VALUES ($1, $2, $3, $4, $5)`,
          ['User1', 'user1@example.com', tenant1.appId, tenant1.organizationId, 'secret-1']
        );
        results.push('tenant1-insert');
      });

      // Transaction 2 - Tenant2
      await db.transaction(tenant2, async (trx) => {
        await trx.execute(
          `INSERT INTO ${testTableName} (name, email, app_id, organization_id, secret_data)
           VALUES ($1, $2, $3, $4, $5)`,
          ['User2', 'user2@example.com', tenant2.appId, tenant2.organizationId, 'secret-2']
        );
        results.push('tenant2-insert');
      });

      expect(results).toEqual(['tenant1-insert', 'tenant2-insert']);

      // Verify data isolation
      const tenant1Count = await driver.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM ${testTableName} WHERE app_id = $1`,
        [tenant1.appId]
      );
      expect(Number(tenant1Count.rows[0].count)).toBe(1);

      const tenant2Count = await driver.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM ${testTableName} WHERE app_id = $1`,
        [tenant2.appId]
      );
      expect(Number(tenant2Count.rows[0].count)).toBe(1);
    });
  });

  describe('Tenant Context Cleanup After Transactions', () => {
    it('should clear session variables after transaction completes', async () => {
      // Run transaction with tenant1
      await db.transaction(tenant1, async (trx) => {
        const result = await trx.raw<{ current_setting: string }>(
          `SELECT current_setting('app.current_app_id', true) as current_setting`
        );
        expect(result.rows[0].current_setting).toBe(tenant1.appId);
      });

      // After transaction, session variables should be cleared or reset
      // This is enforced by PostgreSQL's transaction isolation
      const result = await driver.query<{ current_setting: string | null }>(
        `SELECT current_setting('app.current_app_id', false) as current_setting`
      );

      // Should be empty after transaction (SET LOCAL is transaction-scoped)
      expect(result.rows[0].current_setting || null).toBeNull();
    });

    it('should not leak tenant context between sequential transactions', async () => {
      const contexts: Array<{ appId: string | null }> = [];

      // Transaction 1
      await db.transaction(tenant1, async (trx) => {
        const result = await trx.raw<{ current_setting: string }>(
          `SELECT current_setting('app.current_app_id', true) as current_setting`
        );
        contexts.push({ appId: result.rows[0].current_setting });
      });

      // Transaction 2 with different tenant
      await db.transaction(tenant2, async (trx) => {
        const result = await trx.raw<{ current_setting: string }>(
          `SELECT current_setting('app.current_app_id', true) as current_setting`
        );
        contexts.push({ appId: result.rows[0].current_setting });
      });

      expect(contexts[0].appId).toBe(tenant1.appId);
      expect(contexts[1].appId).toBe(tenant2.appId);
      expect(contexts[0].appId).not.toBe(contexts[1].appId);
    });
  });

  describe('RLS Policy Compatibility', () => {
    it('should work with PostgreSQL RLS policies when enabled', async () => {
      // Create RLS policy on test table
      // FORCE is needed because table owner bypasses RLS by default
      await driver.execute(`
        ALTER TABLE ${testTableName} ENABLE ROW LEVEL SECURITY;
        ALTER TABLE ${testTableName} FORCE ROW LEVEL SECURITY;

        CREATE POLICY rls_tenant_isolation ON ${testTableName}
        FOR ALL
        USING (app_id = current_setting('app.current_app_id', true)
               AND organization_id = current_setting('app.current_org_id', true))
        WITH CHECK (app_id = current_setting('app.current_app_id', true)
                    AND organization_id = current_setting('app.current_org_id', true));
      `);

      // Insert test data (let database generate UUIDs)
      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, app_id, organization_id, secret_data)
         VALUES ($1, $2, $3, $4, $5)`,
        ['User1', 'user1@rls-test.com', tenant1.appId, tenant1.organizationId, 'secret-1']
      );

      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, app_id, organization_id, secret_data)
         VALUES ($1, $2, $3, $4, $5)`,
        ['User2', 'user2@rls-test.com', tenant2.appId, tenant2.organizationId, 'secret-2']
      );

      // Query with tenant1 context and RLS policy
      await db.transaction(tenant1, async (trx) => {
        const result = await trx.raw<{ name: string; app_id: string }>(
          `SELECT name, app_id FROM ${testTableName}`
        );

        // RLS policy should enforce tenant isolation
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]).toMatchObject({
          name: 'User1',
          app_id: tenant1.appId,
        });
      });

      // Cleanup: disable RLS and FORCE
      await driver.execute(`
        ALTER TABLE ${testTableName} NO FORCE ROW LEVEL SECURITY;
        ALTER TABLE ${testTableName} DISABLE ROW LEVEL SECURITY;
        DROP POLICY rls_tenant_isolation ON ${testTableName};
      `);
    });

    it('should enforce combined application-level and RLS protection', async () => {
      // Enable RLS
      await driver.execute(`
        ALTER TABLE ${testTableName} ENABLE ROW LEVEL SECURITY;

        CREATE POLICY rls_combined_policy ON ${testTableName}
        FOR ALL
        USING (app_id = current_setting('app.current_app_id', true))
        WITH CHECK (app_id = current_setting('app.current_app_id', true));
      `);

      // Insert test data (let database generate UUIDs)
      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, app_id, organization_id, secret_data)
         VALUES ($1, $2, $3, $4, $5)`,
        ['User1', 'user1@rls.com', tenant1.appId, tenant1.organizationId, 'secret-1']
      );

      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, app_id, organization_id, secret_data)
         VALUES ($1, $2, $3, $4, $5)`,
        ['User2', 'user2@rls.com', tenant2.appId, tenant2.organizationId, 'secret-2']
      );

      // Both app-level and RLS should enforce isolation
      let recordCount = 0;
      await db.transaction(tenant1, async (trx) => {
        const result = await trx.table(testTableName).select().execute();
        recordCount = result.length;
      });

      expect(recordCount).toBe(1);

      // Cleanup
      await driver.execute(`
        ALTER TABLE ${testTableName} DISABLE ROW LEVEL SECURITY;
        DROP POLICY rls_combined_policy ON ${testTableName};
      `);
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should handle empty results with tenant context', async () => {
      const result = await db.table(testTableName, tenant1).select().execute();
      expect(result).toEqual([]);
    });

    it('should handle concurrent operations with different tenant contexts', async () => {
      // Insert test data for both tenants
      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, app_id, organization_id, secret_data)
         VALUES ($1, $2, $3, $4, $5)`,
        ['User1', 'user1@example.com', tenant1.appId, tenant1.organizationId, 'secret-1']
      );

      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, app_id, organization_id, secret_data)
         VALUES ($1, $2, $3, $4, $5)`,
        ['User2', 'user2@example.com', tenant2.appId, tenant2.organizationId, 'secret-2']
      );

      // Simulate concurrent queries
      const [result1, result2] = await Promise.all([
        db.table(testTableName, tenant1).select().execute(),
        db.table(testTableName, tenant2).select().execute(),
      ]);

      expect(result1).toHaveLength(1);
      expect(result1[0].name).toBe('User1');

      expect(result2).toHaveLength(1);
      expect(result2[0].name).toBe('User2');
    });

    it('should handle WHERE clause with additional conditions alongside tenant context', async () => {
      // Insert data (let the database generate UUIDs)
      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, app_id, organization_id, secret_data)
         VALUES ($1, $2, $3, $4, $5)`,
        ['Active User', 'active@example.com', tenant1.appId, tenant1.organizationId, 'secret']
      );

      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, app_id, organization_id, secret_data)
         VALUES ($1, $2, $3, $4, $5)`,
        ['Inactive User', 'inactive@example.com', tenant1.appId, tenant1.organizationId, 'secret']
      );

      // Query with additional WHERE conditions
      const result = await db
        .table(testTableName, tenant1)
        .where('name', 'like', '%Active%')
        .select()
        .execute();

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Active User');
    });
  });
});
