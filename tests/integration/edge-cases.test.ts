import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDbClient } from '../../src/client.js';
import type { DbClient } from '../../src/client.js';
import { createPostgresDriver } from '../../src/driver/postgresql.js';
import type { Driver } from '../../src/driver/types.js';
import {
  BOUNDARY_VALUES,
  LARGE_DATASET_GENERATORS,
  SQL_INJECTION_PAYLOADS,
  UNICODE_EDGE_CASES,
} from '../fixtures/special-characters.js';

describe.skipIf(!process.env.DATABASE_URL)('Integration Edge Cases', () => {
  let driver: Driver;
  let client: DbClient;
  const testTableName = 'test_edge_cases';

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

    await driver.execute(`DROP TABLE IF EXISTS ${testTableName}`);
    await driver.execute(`
      CREATE TABLE ${testTableName} (
        id SERIAL PRIMARY KEY,
        name VARCHAR(10000),
        email VARCHAR(255) UNIQUE,
        status VARCHAR(50),
        category VARCHAR(50),
        age INTEGER,
        score DECIMAL(10, 2),
        is_active BOOLEAN DEFAULT true,
        metadata JSONB,
        app_id VARCHAR(255) NOT NULL,
        organization_id VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  });

  afterAll(async () => {
    await driver.execute(`DROP TABLE IF EXISTS ${testTableName}`);
    await client.close();
  });

  describe('Transaction Rollback Scenarios', () => {
    const ctx = { appId: 'app-trx', organizationId: 'org-trx' };

    it('should rollback on unique constraint violation', async () => {
      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, app_id, organization_id) VALUES ($1, $2, $3, $4)`,
        ['Existing User', 'unique@example.com', ctx.appId, ctx.organizationId]
      );

      await expect(async () => {
        await driver.transaction(async (trx) => {
          await trx.execute(
            `INSERT INTO ${testTableName} (name, email, app_id, organization_id) VALUES ($1, $2, $3, $4)`,
            ['New User 1', 'new1@example.com', ctx.appId, ctx.organizationId]
          );

          await trx.execute(
            `INSERT INTO ${testTableName} (name, email, app_id, organization_id) VALUES ($1, $2, $3, $4)`,
            ['Duplicate', 'unique@example.com', ctx.appId, ctx.organizationId]
          );
        });
      }).rejects.toThrow();

      const check = await driver.query(`SELECT * FROM ${testTableName} WHERE email = $1`, [
        'new1@example.com',
      ]);
      expect(check.rows).toHaveLength(0);
    });

    it('should rollback on intentional throw', async () => {
      const initialCount = await driver.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM ${testTableName}`
      );
      const startCount = Number(initialCount.rows[0].count);

      await expect(async () => {
        await driver.transaction(async (trx) => {
          await trx.execute(
            `INSERT INTO ${testTableName} (name, email, app_id, organization_id) VALUES ($1, $2, $3, $4)`,
            ['Should Rollback', 'rollback@example.com', 'app-test', 'org-test']
          );
          throw new Error('Intentional rollback for testing');
        });
      }).rejects.toThrow('Intentional rollback for testing');

      const finalCount = await driver.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM ${testTableName}`
      );
      expect(Number(finalCount.rows[0].count)).toBe(startCount);
    });

    it('should rollback multiple inserts on error', async () => {
      await expect(async () => {
        await driver.transaction(async (trx) => {
          for (let i = 0; i < 5; i++) {
            await trx.execute(
              `INSERT INTO ${testTableName} (name, email, app_id, organization_id) VALUES ($1, $2, $3, $4)`,
              [`User ${i}`, `rollback-multi-${i}@example.com`, 'app-multi', 'org-multi']
            );
          }
          throw new Error('Rollback after multiple inserts');
        });
      }).rejects.toThrow();

      const check = await driver.query(`SELECT * FROM ${testTableName} WHERE app_id = $1`, [
        'app-multi',
      ]);
      expect(check.rows).toHaveLength(0);
    });

    it('should commit transaction with mixed read/write operations', async () => {
      const result = await driver.transaction(async (trx) => {
        await trx.execute(
          `INSERT INTO ${testTableName} (name, email, app_id, organization_id) VALUES ($1, $2, $3, $4)`,
          ['Mixed Op User', 'mixed@example.com', 'app-mixed', 'org-mixed']
        );

        const readResult = await trx.query<{ count: number }>(
          `SELECT COUNT(*) as count FROM ${testTableName} WHERE app_id = $1`,
          ['app-mixed']
        );

        await trx.execute(`UPDATE ${testTableName} SET status = $1 WHERE email = $2`, [
          'verified',
          'mixed@example.com',
        ]);

        return Number(readResult.rows[0].count);
      });

      expect(result).toBe(1);

      const verify = await driver.query<{ status: string }>(
        `SELECT status FROM ${testTableName} WHERE email = $1`,
        ['mixed@example.com']
      );
      expect(verify.rows[0].status).toBe('verified');
    });

    it('should handle nested queries within transaction', async () => {
      const result = await driver.transaction(async (trx) => {
        const insert1 = await trx.query<{ id: number }>(
          `INSERT INTO ${testTableName} (name, email, app_id, organization_id) VALUES ($1, $2, $3, $4) RETURNING id`,
          ['Parent', 'parent@example.com', 'app-nested', 'org-nested']
        );

        const insert2 = await trx.query<{ id: number }>(
          `INSERT INTO ${testTableName} (name, email, app_id, organization_id) VALUES ($1, $2, $3, $4) RETURNING id`,
          ['Child', 'child@example.com', 'app-nested', 'org-nested']
        );

        return {
          parentId: insert1.rows[0].id,
          childId: insert2.rows[0].id,
        };
      });

      expect(result.parentId).toBeDefined();
      expect(result.childId).toBeDefined();
      expect(result.childId).toBeGreaterThan(result.parentId);
    });
  });

  describe('Large Dataset Operations', () => {
    const ctx = { appId: 'app-large', organizationId: 'org-large' };

    it('should handle IN clause with 100 values', async () => {
      const ids: number[] = [];
      for (let i = 0; i < 100; i++) {
        const result = await driver.query<{ id: number }>(
          `INSERT INTO ${testTableName} (name, email, app_id, organization_id) VALUES ($1, $2, $3, $4) RETURNING id`,
          [`Large User ${i}`, `large-${i}@example.com`, ctx.appId, ctx.organizationId]
        );
        ids.push(result.rows[0].id);
      }

      const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
      const query = `SELECT COUNT(*) as count FROM ${testTableName} WHERE id IN (${placeholders})`;
      const result = await driver.query<{ count: number }>(query, ids);

      expect(Number(result.rows[0].count)).toBe(100);
    });

    it('should handle bulk insert with 50 rows', async () => {
      const values: string[] = [];
      const params: unknown[] = [];
      let paramIndex = 1;

      for (let i = 0; i < 50; i++) {
        values.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
        params.push(`Bulk User ${i}`, `bulk-${i}@example.com`, 'app-bulk', 'org-bulk');
      }

      const sql = `INSERT INTO ${testTableName} (name, email, app_id, organization_id) VALUES ${values.join(', ')}`;
      await driver.execute(sql, params);

      const count = await driver.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM ${testTableName} WHERE app_id = $1`,
        ['app-bulk']
      );
      expect(Number(count.rows[0].count)).toBe(50);
    });

    it('should handle query with large result set', async () => {
      const result = await driver.query<{ id: number; name: string }>(
        `SELECT id, name FROM ${testTableName} WHERE app_id IN ($1, $2, $3) ORDER BY id`,
        [ctx.appId, 'app-bulk', 'app-large']
      );

      expect(result.rows.length).toBeGreaterThan(0);
      expect(result.rowCount).toBe(result.rows.length);
    });

    it('should handle NOT IN with many values', async () => {
      const excludeIds = LARGE_DATASET_GENERATORS.generateIds(50);
      const placeholders = excludeIds.map((_, i) => `$${i + 1}`).join(', ');

      const result = await driver.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM ${testTableName} WHERE id NOT IN (${placeholders})`,
        excludeIds
      );

      expect(Number(result.rows[0].count)).toBeGreaterThanOrEqual(0);
    });
  });

  describe('SQL Injection Prevention (Integration)', () => {
    const ctx = { appId: 'app-inject', organizationId: 'org-inject' };

    it('should safely store and retrieve SQL injection payloads', async () => {
      for (const { input, description } of SQL_INJECTION_PAYLOADS.slice(0, 5)) {
        const email = `inject-${Math.random().toString(36).slice(2)}@example.com`;
        await driver.execute(
          `INSERT INTO ${testTableName} (name, email, app_id, organization_id) VALUES ($1, $2, $3, $4)`,
          [input, email, ctx.appId, ctx.organizationId]
        );

        const result = await driver.query<{ name: string }>(
          `SELECT name FROM ${testTableName} WHERE email = $1`,
          [email]
        );

        expect(result.rows[0].name).toBe(input);
      }
    });

    it('should safely use injection payload in WHERE clause', async () => {
      const maliciousValue = "'; DROP TABLE test_edge_cases; --";

      const result = await driver.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM ${testTableName} WHERE name = $1`,
        [maliciousValue]
      );

      const tableCheck = await driver.query(
        'SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1)',
        [testTableName]
      );
      expect(tableCheck.rows[0].exists).toBe(true);
    });

    it('should safely use injection payload in LIKE clause', async () => {
      const maliciousPattern = "%'; DELETE FROM test_edge_cases; --%";

      const result = await driver.query(
        `SELECT * FROM ${testTableName} WHERE name LIKE $1 LIMIT 5`,
        [maliciousPattern]
      );

      expect(result).toBeDefined();
    });
  });

  describe('Unicode and Special Characters', () => {
    const ctx = { appId: 'app-unicode', organizationId: 'org-unicode' };

    it('should store and retrieve unicode characters', async () => {
      for (const { char, name } of UNICODE_EDGE_CASES.slice(0, 5)) {
        const testValue = `test_${char}_value`;
        const email = `unicode-${Math.random().toString(36).slice(2)}@example.com`;

        await driver.execute(
          `INSERT INTO ${testTableName} (name, email, app_id, organization_id) VALUES ($1, $2, $3, $4)`,
          [testValue, email, ctx.appId, ctx.organizationId]
        );

        const result = await driver.query<{ name: string }>(
          `SELECT name FROM ${testTableName} WHERE email = $1`,
          [email]
        );

        expect(result.rows[0].name).toBe(testValue);
      }
    });

    it('should handle emoji in data', async () => {
      const emojiName = 'Test 🎉🔥💯 User';
      const email = `emoji-${Date.now()}@example.com`;

      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, app_id, organization_id) VALUES ($1, $2, $3, $4)`,
        [emojiName, email, ctx.appId, ctx.organizationId]
      );

      const result = await driver.query<{ name: string }>(
        `SELECT name FROM ${testTableName} WHERE email = $1`,
        [email]
      );

      expect(result.rows[0].name).toBe(emojiName);
    });

    it('should handle CJK characters', async () => {
      const cjkName = '测试用户 テスト 테스트';
      const email = `cjk-${Date.now()}@example.com`;

      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, app_id, organization_id) VALUES ($1, $2, $3, $4)`,
        [cjkName, email, ctx.appId, ctx.organizationId]
      );

      const result = await driver.query<{ name: string }>(
        `SELECT name FROM ${testTableName} WHERE email = $1`,
        [email]
      );

      expect(result.rows[0].name).toBe(cjkName);
    });
  });

  describe('Boundary Value Tests', () => {
    const ctx = { appId: 'app-boundary', organizationId: 'org-boundary' };

    it('should handle max int32 value', async () => {
      const email = `int32-max-${Date.now()}@example.com`;
      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, age, app_id, organization_id) VALUES ($1, $2, $3, $4, $5)`,
        ['Max Int', email, BOUNDARY_VALUES.integers.maxInt32, ctx.appId, ctx.organizationId]
      );

      const result = await driver.query<{ age: number }>(
        `SELECT age FROM ${testTableName} WHERE email = $1`,
        [email]
      );

      expect(result.rows[0].age).toBe(BOUNDARY_VALUES.integers.maxInt32);
    });

    it('should handle min int32 value', async () => {
      const email = `int32-min-${Date.now()}@example.com`;
      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, age, app_id, organization_id) VALUES ($1, $2, $3, $4, $5)`,
        ['Min Int', email, BOUNDARY_VALUES.integers.minInt32, ctx.appId, ctx.organizationId]
      );

      const result = await driver.query<{ age: number }>(
        `SELECT age FROM ${testTableName} WHERE email = $1`,
        [email]
      );

      expect(result.rows[0].age).toBe(BOUNDARY_VALUES.integers.minInt32);
    });

    it('should handle empty string', async () => {
      const email = `empty-${Date.now()}@example.com`;
      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, status, app_id, organization_id) VALUES ($1, $2, $3, $4, $5)`,
        ['Empty Status', email, '', ctx.appId, ctx.organizationId]
      );

      const result = await driver.query<{ status: string }>(
        `SELECT status FROM ${testTableName} WHERE email = $1`,
        [email]
      );

      expect(result.rows[0].status).toBe('');
    });

    it('should handle very long string (1000 chars)', async () => {
      const longName = 'a'.repeat(1000);
      const email = `long-${Date.now()}@example.com`;

      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, app_id, organization_id) VALUES ($1, $2, $3, $4)`,
        [longName, email, ctx.appId, ctx.organizationId]
      );

      const result = await driver.query<{ name: string }>(
        `SELECT name FROM ${testTableName} WHERE email = $1`,
        [email]
      );

      expect(result.rows[0].name).toBe(longName);
      expect(result.rows[0].name.length).toBe(1000);
    });

    it('should handle zero value', async () => {
      const email = `zero-${Date.now()}@example.com`;
      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, age, app_id, organization_id) VALUES ($1, $2, $3, $4, $5)`,
        ['Zero Age', email, 0, ctx.appId, ctx.organizationId]
      );

      const result = await driver.query<{ age: number }>(
        `SELECT age FROM ${testTableName} WHERE email = $1`,
        [email]
      );

      expect(result.rows[0].age).toBe(0);
    });

    it('should handle negative numbers', async () => {
      const email = `negative-${Date.now()}@example.com`;
      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, age, app_id, organization_id) VALUES ($1, $2, $3, $4, $5)`,
        ['Negative', email, -100, ctx.appId, ctx.organizationId]
      );

      const result = await driver.query<{ age: number }>(
        `SELECT age FROM ${testTableName} WHERE email = $1`,
        [email]
      );

      expect(result.rows[0].age).toBe(-100);
    });

    it('should handle decimal precision', async () => {
      const email = `decimal-${Date.now()}@example.com`;
      const preciseValue = 123.45;

      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, score, app_id, organization_id) VALUES ($1, $2, $3, $4, $5)`,
        ['Decimal', email, preciseValue, ctx.appId, ctx.organizationId]
      );

      const result = await driver.query<{ score: string }>(
        `SELECT score FROM ${testTableName} WHERE email = $1`,
        [email]
      );

      expect(Number.parseFloat(result.rows[0].score)).toBeCloseTo(preciseValue, 2);
    });
  });

  describe('Complex Query Scenarios', () => {
    const ctx = { appId: 'app-complex', organizationId: 'org-complex' };

    beforeAll(async () => {
      const categories = ['electronics', 'clothing', 'books'];
      const statuses = ['active', 'pending', 'inactive'];

      for (let i = 0; i < 30; i++) {
        await driver.execute(
          `INSERT INTO ${testTableName} (name, email, category, status, age, app_id, organization_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            `Complex User ${i}`,
            `complex-${i}@example.com`,
            categories[i % 3],
            statuses[i % 3],
            20 + (i % 50),
            ctx.appId,
            ctx.organizationId,
          ]
        );
      }
    });

    it('should handle GROUP BY with COUNT', async () => {
      const result = await driver.query<{ category: string; count: number }>(
        `SELECT category, COUNT(*) as count
         FROM ${testTableName}
         WHERE app_id = $1
         GROUP BY category
         ORDER BY count DESC`,
        [ctx.appId]
      );

      expect(result.rows.length).toBeGreaterThan(0);
      expect(result.rows[0]).toHaveProperty('category');
      expect(result.rows[0]).toHaveProperty('count');
    });

    it('should handle GROUP BY + HAVING', async () => {
      const result = await driver.query<{ category: string; count: number }>(
        `SELECT category, COUNT(*) as count
         FROM ${testTableName}
         WHERE app_id = $1
         GROUP BY category
         HAVING COUNT(*) >= $2`,
        [ctx.appId, 5]
      );

      for (const row of result.rows) {
        expect(Number(row.count)).toBeGreaterThanOrEqual(5);
      }
    });

    it('should handle complex WHERE with OR/AND', async () => {
      const result = await driver.query<{ name: string }>(
        `SELECT name FROM ${testTableName}
         WHERE app_id = $1
         AND (status = $2 OR status = $3)
         AND age > $4
         ORDER BY name
         LIMIT 10`,
        [ctx.appId, 'active', 'pending', 25]
      );

      expect(result.rows.length).toBeLessThanOrEqual(10);
    });

    it('should handle ORDER BY + LIMIT + OFFSET', async () => {
      const page1 = await driver.query<{ name: string }>(
        `SELECT name FROM ${testTableName}
         WHERE app_id = $1
         ORDER BY name ASC
         LIMIT $2 OFFSET $3`,
        [ctx.appId, 5, 0]
      );

      const page2 = await driver.query<{ name: string }>(
        `SELECT name FROM ${testTableName}
         WHERE app_id = $1
         ORDER BY name ASC
         LIMIT $2 OFFSET $3`,
        [ctx.appId, 5, 5]
      );

      expect(page1.rows.length).toBe(5);
      expect(page2.rows.length).toBe(5);
      expect(page1.rows[0].name).not.toBe(page2.rows[0].name);
    });

    it('should handle IN with subquery pattern', async () => {
      const subquery = await driver.query<{ category: string }>(
        `SELECT DISTINCT category FROM ${testTableName} WHERE status = $1 LIMIT 2`,
        ['active']
      );
      const categories = subquery.rows.map((r) => r.category);

      if (categories.length > 0) {
        const placeholders = categories.map((_, i) => `$${i + 2}`).join(', ');
        const result = await driver.query<{ count: number }>(
          `SELECT COUNT(*) as count FROM ${testTableName} WHERE app_id = $1 AND category IN (${placeholders})`,
          [ctx.appId, ...categories]
        );

        expect(Number(result.rows[0].count)).toBeGreaterThan(0);
      }
    });
  });
});
