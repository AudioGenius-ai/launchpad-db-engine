import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDbClient } from '../../src/client.js';
import type { DbClient } from '../../src/client.js';
import { createPostgresDriver } from '../../src/driver/postgresql.js';
import type { Driver } from '../../src/driver/types.js';

describe.skipIf(!process.env.DATABASE_URL)('PostgreSQL RLS Policy Enforcement', () => {
  let driver: Driver;
  let client: DbClient;
  const tableName = 'test_rls_documents';
  const testRole = 'test_rls_user';

  const TENANT_A = { appId: 'app-tenant-a', organizationId: 'org-tenant-a' };
  const TENANT_B = { appId: 'app-tenant-b', organizationId: 'org-tenant-b' };
  const TENANT_C = { appId: 'app-tenant-c', organizationId: 'org-tenant-c' };

  async function withRLS<T>(
    tenant: { appId: string; organizationId: string },
    fn: (trx: Parameters<Parameters<typeof client.transaction>[1]>[0]) => Promise<T>
  ): Promise<T> {
    return client.transaction(tenant, async (trx) => {
      await trx.raw(`SET ROLE ${testRole}`);
      try {
        return await fn(trx);
      } finally {
        await trx.raw('RESET ROLE');
      }
    });
  }

  const seedTestData = async () => {
    await driver.execute(`TRUNCATE TABLE ${tableName} RESTART IDENTITY`);

    await driver.execute(
      `INSERT INTO ${tableName} (title, content, app_id, organization_id, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      ['Doc A1', 'Content A1', TENANT_A.appId, TENANT_A.organizationId, 'user-a']
    );
    await driver.execute(
      `INSERT INTO ${tableName} (title, content, app_id, organization_id, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      ['Doc A2', 'Content A2', TENANT_A.appId, TENANT_A.organizationId, 'user-a']
    );
    await driver.execute(
      `INSERT INTO ${tableName} (title, content, app_id, organization_id, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      ['Doc A3', 'Content A3', TENANT_A.appId, TENANT_A.organizationId, 'user-a']
    );

    await driver.execute(
      `INSERT INTO ${tableName} (title, content, app_id, organization_id, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      ['Doc B1', 'Content B1', TENANT_B.appId, TENANT_B.organizationId, 'user-b']
    );
    await driver.execute(
      `INSERT INTO ${tableName} (title, content, app_id, organization_id, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      ['Doc B2', 'Content B2', TENANT_B.appId, TENANT_B.organizationId, 'user-b']
    );
  };

  beforeAll(async () => {
    driver = createPostgresDriver({
      connectionString: process.env.DATABASE_URL as string,
    });

    client = createDbClient(driver, {
      tenantColumns: {
        appId: 'app_id',
        organizationId: 'organization_id',
      },
    });

    try {
      await driver.execute('ALTER EVENT TRIGGER auto_perms_on_policy_change DISABLE');
      await driver.execute('ALTER EVENT TRIGGER auto_perms_on_table_create DISABLE');
      await driver.execute('ALTER EVENT TRIGGER auto_perms_on_rls_enable DISABLE');
    } catch {}

    try {
      await driver.execute(`DROP ROLE IF EXISTS ${testRole}`);
    } catch {}
    await driver.execute(`CREATE ROLE ${testRole} NOLOGIN`);

    await driver.execute(`DROP TABLE IF EXISTS ${tableName} CASCADE`);

    await driver.execute(`
      CREATE TABLE ${tableName} (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        content TEXT,
        app_id VARCHAR(255) NOT NULL,
        organization_id VARCHAR(255) NOT NULL,
        created_by VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await driver.execute(`ALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY`);
    await driver.execute(`ALTER TABLE ${tableName} FORCE ROW LEVEL SECURITY`);

    await driver.execute(`
      CREATE POLICY tenant_isolation_select ON ${tableName}
        FOR SELECT
        USING (
          app_id = current_setting('app.current_app_id', true) AND
          organization_id = current_setting('app.current_org_id', true)
        )
    `);

    await driver.execute(`
      CREATE POLICY tenant_isolation_insert ON ${tableName}
        FOR INSERT
        WITH CHECK (
          app_id = current_setting('app.current_app_id', true) AND
          organization_id = current_setting('app.current_org_id', true)
        )
    `);

    await driver.execute(`
      CREATE POLICY tenant_isolation_update ON ${tableName}
        FOR UPDATE
        USING (
          app_id = current_setting('app.current_app_id', true) AND
          organization_id = current_setting('app.current_org_id', true)
        )
        WITH CHECK (
          app_id = current_setting('app.current_app_id', true) AND
          organization_id = current_setting('app.current_org_id', true)
        )
    `);

    await driver.execute(`
      CREATE POLICY tenant_isolation_delete ON ${tableName}
        FOR DELETE
        USING (
          app_id = current_setting('app.current_app_id', true) AND
          organization_id = current_setting('app.current_org_id', true)
        )
    `);

    await driver.execute(`GRANT ALL ON ${tableName} TO ${testRole}`);
    await driver.execute(`GRANT USAGE ON SEQUENCE ${tableName}_id_seq TO ${testRole}`);
  });

  afterAll(async () => {
    await driver.execute(`DROP TABLE IF EXISTS ${tableName} CASCADE`);
    try {
      await driver.execute(`DROP ROLE IF EXISTS ${testRole}`);
    } catch {}
    try {
      await driver.execute('ALTER EVENT TRIGGER auto_perms_on_policy_change ENABLE');
      await driver.execute('ALTER EVENT TRIGGER auto_perms_on_table_create ENABLE');
      await driver.execute('ALTER EVENT TRIGGER auto_perms_on_rls_enable ENABLE');
    } catch {}
    await client.close();
  });

  beforeEach(async () => {
    await seedTestData();
  });

  describe('SELECT Enforcement', () => {
    it('should only return rows matching current tenant context', async () => {
      const result = await withRLS(TENANT_A, async (trx) => {
        return trx.raw<{ id: number; title: string }>(`SELECT id, title FROM ${tableName}`);
      });

      expect(result.rows).toHaveLength(3);
      expect(result.rows.map((r) => r.title).sort()).toEqual(['Doc A1', 'Doc A2', 'Doc A3']);
    });

    it('should return different rows for different tenant contexts', async () => {
      const resultA = await withRLS(TENANT_A, async (trx) => {
        return trx.raw<{ title: string }>(`SELECT title FROM ${tableName}`);
      });

      const resultB = await withRLS(TENANT_B, async (trx) => {
        return trx.raw<{ title: string }>(`SELECT title FROM ${tableName}`);
      });

      expect(resultA.rows).toHaveLength(3);
      expect(resultB.rows).toHaveLength(2);

      expect(resultA.rows.map((r) => r.title)).not.toContain('Doc B1');
      expect(resultB.rows.map((r) => r.title)).not.toContain('Doc A1');
    });

    it('should return empty result when no rows match tenant context', async () => {
      const result = await withRLS(TENANT_C, async (trx) => {
        return trx.raw<{ id: number }>(`SELECT id FROM ${tableName}`);
      });

      expect(result.rows).toHaveLength(0);
    });

    it('should not leak data between tenants via COUNT', async () => {
      const countA = await withRLS(TENANT_A, async (trx) => {
        return trx.raw<{ count: string }>(`SELECT COUNT(*) as count FROM ${tableName}`);
      });

      const countB = await withRLS(TENANT_B, async (trx) => {
        return trx.raw<{ count: string }>(`SELECT COUNT(*) as count FROM ${tableName}`);
      });

      expect(Number(countA.rows[0].count)).toBe(3);
      expect(Number(countB.rows[0].count)).toBe(2);
    });

    it('should handle WHERE clause combined with RLS filtering', async () => {
      const result = await withRLS(TENANT_A, async (trx) => {
        return trx.raw<{ title: string }>(
          `SELECT title FROM ${tableName} WHERE title LIKE 'Doc A%'`
        );
      });

      expect(result.rows).toHaveLength(3);

      const resultWithSpecific = await withRLS(TENANT_A, async (trx) => {
        return trx.raw<{ title: string }>(`SELECT title FROM ${tableName} WHERE title = $1`, [
          'Doc B1',
        ]);
      });

      expect(resultWithSpecific.rows).toHaveLength(0);
    });
  });

  describe('INSERT Enforcement', () => {
    it('should allow INSERT when tenant context matches data', async () => {
      const result = await withRLS(TENANT_A, async (trx) => {
        return trx.raw<{ id: number }>(
          `INSERT INTO ${tableName} (title, content, app_id, organization_id, created_by)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          ['New Doc A', 'New content', TENANT_A.appId, TENANT_A.organizationId, 'user-a']
        );
      });

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].id).toBeGreaterThan(0);

      const verify = await withRLS(TENANT_A, async (trx) => {
        return trx.raw<{ title: string }>(`SELECT title FROM ${tableName} WHERE title = $1`, [
          'New Doc A',
        ]);
      });

      expect(verify.rows).toHaveLength(1);
    });

    it('should reject INSERT when app_id does not match context', async () => {
      await expect(async () => {
        await withRLS(TENANT_A, async (trx) => {
          await trx.execute(
            `INSERT INTO ${tableName} (title, content, app_id, organization_id, created_by)
             VALUES ($1, $2, $3, $4, $5)`,
            ['Bad Doc', 'Content', TENANT_B.appId, TENANT_A.organizationId, 'attacker']
          );
        });
      }).rejects.toThrow();
    });

    it('should reject INSERT when organization_id does not match context', async () => {
      await expect(async () => {
        await withRLS(TENANT_A, async (trx) => {
          await trx.execute(
            `INSERT INTO ${tableName} (title, content, app_id, organization_id, created_by)
             VALUES ($1, $2, $3, $4, $5)`,
            ['Bad Doc', 'Content', TENANT_A.appId, TENANT_B.organizationId, 'attacker']
          );
        });
      }).rejects.toThrow();
    });

    it('should reject INSERT when both app_id and organization_id mismatch', async () => {
      await expect(async () => {
        await withRLS(TENANT_A, async (trx) => {
          await trx.execute(
            `INSERT INTO ${tableName} (title, content, app_id, organization_id, created_by)
             VALUES ($1, $2, $3, $4, $5)`,
            ['Bad Doc', 'Content', TENANT_B.appId, TENANT_B.organizationId, 'attacker']
          );
        });
      }).rejects.toThrow();
    });
  });

  describe('UPDATE Enforcement', () => {
    it('should only UPDATE rows belonging to current tenant', async () => {
      const result = await withRLS(TENANT_A, async (trx) => {
        return trx.raw<{ id: number }>(
          `UPDATE ${tableName} SET content = 'Updated by A' RETURNING id`
        );
      });

      expect(result.rows).toHaveLength(3);

      const tenantADocs = await withRLS(TENANT_A, async (trx) => {
        return trx.raw<{ content: string }>(`SELECT content FROM ${tableName}`);
      });

      expect(tenantADocs.rows.every((r) => r.content === 'Updated by A')).toBe(true);

      const tenantBDocs = await withRLS(TENANT_B, async (trx) => {
        return trx.raw<{ content: string }>(`SELECT content FROM ${tableName}`);
      });

      expect(tenantBDocs.rows.every((r) => r.content.startsWith('Content B'))).toBe(true);
    });

    it('should affect 0 rows when targeting another tenant data', async () => {
      const result = await withRLS(TENANT_A, async (trx) => {
        return trx.raw<{ id: number }>(
          `UPDATE ${tableName} SET content = 'Hacked' WHERE title = 'Doc B1' RETURNING id`
        );
      });

      expect(result.rows).toHaveLength(0);

      const verify = await withRLS(TENANT_B, async (trx) => {
        return trx.raw<{ content: string }>(`SELECT content FROM ${tableName} WHERE title = $1`, [
          'Doc B1',
        ]);
      });

      expect(verify.rows[0].content).toBe('Content B1');
    });

    it('should reject UPDATE that changes app_id to mismatched value', async () => {
      await expect(async () => {
        await withRLS(TENANT_A, async (trx) => {
          await trx.execute(`UPDATE ${tableName} SET app_id = $1 WHERE title = $2`, [
            TENANT_B.appId,
            'Doc A1',
          ]);
        });
      }).rejects.toThrow();
    });

    it('should reject UPDATE that changes organization_id to mismatched value', async () => {
      await expect(async () => {
        await withRLS(TENANT_A, async (trx) => {
          await trx.execute(`UPDATE ${tableName} SET organization_id = $1 WHERE title = $2`, [
            TENANT_B.organizationId,
            'Doc A1',
          ]);
        });
      }).rejects.toThrow();
    });
  });

  describe('DELETE Enforcement', () => {
    it('should only DELETE rows belonging to current tenant', async () => {
      const result = await withRLS(TENANT_A, async (trx) => {
        return trx.raw<{ id: number }>(
          `DELETE FROM ${tableName} WHERE title = 'Doc A1' RETURNING id`
        );
      });

      expect(result.rows).toHaveLength(1);

      const remainingA = await withRLS(TENANT_A, async (trx) => {
        return trx.raw<{ count: string }>(`SELECT COUNT(*) as count FROM ${tableName}`);
      });

      expect(Number(remainingA.rows[0].count)).toBe(2);

      const remainingB = await withRLS(TENANT_B, async (trx) => {
        return trx.raw<{ count: string }>(`SELECT COUNT(*) as count FROM ${tableName}`);
      });

      expect(Number(remainingB.rows[0].count)).toBe(2);
    });

    it('should affect 0 rows when targeting another tenant data', async () => {
      const result = await withRLS(TENANT_A, async (trx) => {
        return trx.raw<{ id: number }>(
          `DELETE FROM ${tableName} WHERE title = 'Doc B1' RETURNING id`
        );
      });

      expect(result.rows).toHaveLength(0);

      const verify = await withRLS(TENANT_B, async (trx) => {
        return trx.raw<{ count: string }>(`SELECT COUNT(*) as count FROM ${tableName}`);
      });

      expect(Number(verify.rows[0].count)).toBe(2);
    });

    it('should delete all tenant rows when no WHERE clause', async () => {
      await withRLS(TENANT_A, async (trx) => {
        await trx.execute(`DELETE FROM ${tableName}`);
      });

      const remainingA = await withRLS(TENANT_A, async (trx) => {
        return trx.raw<{ count: string }>(`SELECT COUNT(*) as count FROM ${tableName}`);
      });

      expect(Number(remainingA.rows[0].count)).toBe(0);

      const remainingB = await withRLS(TENANT_B, async (trx) => {
        return trx.raw<{ count: string }>(`SELECT COUNT(*) as count FROM ${tableName}`);
      });

      expect(Number(remainingB.rows[0].count)).toBe(2);
    });
  });

  describe('Transaction Context', () => {
    it('should maintain RLS enforcement throughout entire transaction', async () => {
      const results = await withRLS(TENANT_A, async (trx) => {
        const select1 = await trx.raw<{ count: string }>(
          `SELECT COUNT(*) as count FROM ${tableName}`
        );

        await trx.execute(
          `INSERT INTO ${tableName} (title, content, app_id, organization_id, created_by)
           VALUES ($1, $2, $3, $4, $5)`,
          ['Doc A4', 'Content A4', TENANT_A.appId, TENANT_A.organizationId, 'user-a']
        );

        const select2 = await trx.raw<{ count: string }>(
          `SELECT COUNT(*) as count FROM ${tableName}`
        );

        await trx.raw<{ id: number }>(
          `UPDATE ${tableName} SET content = 'Updated in trx' WHERE title = 'Doc A1' RETURNING id`
        );

        const select3 = await trx.raw<{ count: string }>(
          `SELECT COUNT(*) as count FROM ${tableName}`
        );

        return {
          countBefore: Number(select1.rows[0].count),
          countAfterInsert: Number(select2.rows[0].count),
          countAfterUpdate: Number(select3.rows[0].count),
        };
      });

      expect(results.countBefore).toBe(3);
      expect(results.countAfterInsert).toBe(4);
      expect(results.countAfterUpdate).toBe(4);
    });

    it('should not leak tenant data on rollback', async () => {
      const initialCountA = await withRLS(TENANT_A, async (trx) => {
        return trx.raw<{ count: string }>(`SELECT COUNT(*) as count FROM ${tableName}`);
      });

      await expect(async () => {
        await withRLS(TENANT_A, async (trx) => {
          await trx.execute(
            `INSERT INTO ${tableName} (title, content, app_id, organization_id, created_by)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              'Rollback Doc',
              'Will be rolled back',
              TENANT_A.appId,
              TENANT_A.organizationId,
              'user-a',
            ]
          );

          const midCount = await trx.raw<{ count: string }>(
            `SELECT COUNT(*) as count FROM ${tableName}`
          );

          expect(Number(midCount.rows[0].count)).toBe(4);

          throw new Error('Force rollback');
        });
      }).rejects.toThrow('Force rollback');

      const finalCountA = await withRLS(TENANT_A, async (trx) => {
        return trx.raw<{ count: string }>(`SELECT COUNT(*) as count FROM ${tableName}`);
      });

      expect(Number(finalCountA.rows[0].count)).toBe(Number(initialCountA.rows[0].count));

      const verifyNoLeak = await withRLS(TENANT_B, async (trx) => {
        return trx.raw<{ title: string }>(`SELECT title FROM ${tableName} WHERE title = $1`, [
          'Rollback Doc',
        ]);
      });

      expect(verifyNoLeak.rows).toHaveLength(0);
    });

    it('should properly isolate sequential transactions from different tenants', async () => {
      const resultA1 = await withRLS(TENANT_A, async (trx) => {
        return trx.raw<{ count: string }>(`SELECT COUNT(*) as count FROM ${tableName}`);
      });

      const resultB = await withRLS(TENANT_B, async (trx) => {
        return trx.raw<{ count: string }>(`SELECT COUNT(*) as count FROM ${tableName}`);
      });

      const resultA2 = await withRLS(TENANT_A, async (trx) => {
        return trx.raw<{ count: string }>(`SELECT COUNT(*) as count FROM ${tableName}`);
      });

      expect(Number(resultA1.rows[0].count)).toBe(3);
      expect(Number(resultB.rows[0].count)).toBe(2);
      expect(Number(resultA2.rows[0].count)).toBe(3);
    });

    it('should handle multiple INSERT operations in single transaction', async () => {
      await withRLS(TENANT_A, async (trx) => {
        for (let i = 0; i < 5; i++) {
          await trx.execute(
            `INSERT INTO ${tableName} (title, content, app_id, organization_id, created_by)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              `Batch Doc ${i}`,
              `Batch content ${i}`,
              TENANT_A.appId,
              TENANT_A.organizationId,
              'batch-user',
            ]
          );
        }
      });

      const count = await withRLS(TENANT_A, async (trx) => {
        return trx.raw<{ count: string }>(`SELECT COUNT(*) as count FROM ${tableName}`);
      });

      expect(Number(count.rows[0].count)).toBe(8);

      const tenantBCount = await withRLS(TENANT_B, async (trx) => {
        return trx.raw<{ count: string }>(`SELECT COUNT(*) as count FROM ${tableName}`);
      });

      expect(Number(tenantBCount.rows[0].count)).toBe(2);
    });

    it('should enforce RLS on complex queries with JOINs', async () => {
      const result = await withRLS(TENANT_A, async (trx) => {
        return trx.raw<{ title: string; total: string }>(
          `SELECT d.title, (SELECT COUNT(*) FROM ${tableName}) as total
           FROM ${tableName} d
           WHERE d.title = 'Doc A1'`
        );
      });

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].title).toBe('Doc A1');
      expect(Number(result.rows[0].total)).toBe(3);
    });
  });
});
