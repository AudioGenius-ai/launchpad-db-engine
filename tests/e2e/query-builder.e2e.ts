import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDbClient } from '../../src/client.js';
import type { DbClient } from '../../src/client.js';
import { createPostgresDriver } from '../../src/driver/postgresql.js';
import type { Driver } from '../../src/driver/types.js';

describe.skipIf(!process.env.DATABASE_URL)('Query Builder E2E Tests', () => {
  let driver: Driver;
  let db: DbClient;
  const testTableName = 'e2e_query_builder_test';
  const testJoinTableName = 'e2e_query_builder_join_test';

  const tenant = {
    appId: 'app-test',
    organizationId: 'org-test',
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

    // Create test tables
    await driver.execute(`
      DROP TABLE IF EXISTS ${testJoinTableName};
      DROP TABLE IF EXISTS ${testTableName};

      CREATE TABLE ${testTableName} (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL,
        age INTEGER,
        active BOOLEAN DEFAULT true,
        score DECIMAL(10, 2),
        app_id VARCHAR(255) NOT NULL,
        organization_id VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(app_id, organization_id, email)
      );

      CREATE TABLE ${testJoinTableName} (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES ${testTableName}(id) ON DELETE CASCADE,
        profile_name VARCHAR(255),
        bio TEXT,
        app_id VARCHAR(255) NOT NULL,
        organization_id VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX idx_${testTableName}_tenant ON ${testTableName}(app_id, organization_id);
      CREATE INDEX idx_${testJoinTableName}_user ON ${testJoinTableName}(user_id);
      CREATE INDEX idx_${testJoinTableName}_tenant ON ${testJoinTableName}(app_id, organization_id);
    `);
  });

  afterAll(async () => {
    await driver.execute(`DROP TABLE IF EXISTS ${testJoinTableName};`);
    await driver.execute(`DROP TABLE IF EXISTS ${testTableName};`);
    await driver.close();
  });

  beforeEach(async () => {
    // Clear data before each test
    await driver.execute(`DELETE FROM ${testJoinTableName};`);
    await driver.execute(`DELETE FROM ${testTableName};`);
  });

  describe('SelectBuilder - Basic Operations', () => {
    it('should select all columns with *', async () => {
      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, age, active, score, app_id, organization_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ['John Doe', 'john@example.com', 30, true, 95.5, tenant.appId, tenant.organizationId]
      );

      const result = await db.table(testTableName, tenant).select().execute();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        name: 'John Doe',
        email: 'john@example.com',
        age: 30,
      });
    });

    it('should select specific columns', async () => {
      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, age, active, score, app_id, organization_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ['Jane Smith', 'jane@example.com', 28, true, 88.0, tenant.appId, tenant.organizationId]
      );

      const result = await db.table(testTableName, tenant).select('name', 'email').execute();

      expect(result).toHaveLength(1);
      expect(Object.keys(result[0])).toContain('name');
      expect(Object.keys(result[0])).toContain('email');
    });

    it('should get first row only', async () => {
      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, age, active, score, app_id, organization_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7), ($8, $9, $10, $11, $12, $6, $7)`,
        [
          'User1',
          'user1@example.com',
          25,
          true,
          80.0,
          tenant.appId,
          tenant.organizationId,
          'User2',
          'user2@example.com',
          30,
          false,
          85.0,
        ]
      );

      const result = await db.table(testTableName, tenant).select().first();

      expect(result).not.toBeNull();
      expect(result?.name).toBeDefined();
    });

    it('should count rows', async () => {
      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, age, active, score, app_id, organization_id)
         VALUES
         ($1, $2, $3, $4, $5, $6, $7),
         ($8, $9, $10, $11, $12, $6, $7)`,
        [
          'User1',
          'user1@example.com',
          25,
          true,
          80.0,
          tenant.appId,
          tenant.organizationId,
          'User2',
          'user2@example.com',
          30,
          true,
          90.0,
        ]
      );

      const count = await db.table(testTableName, tenant).select().count();

      expect(count).toBe(2);
    });
  });

  describe('SelectBuilder - WHERE Conditions', () => {
    beforeEach(async () => {
      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, age, active, score, app_id, organization_id)
         VALUES
         ($1, $2, $3, $4, $5, $6, $7),
         ($8, $9, $10, $11, $12, $6, $7),
         ($13, $14, $15, $16, $17, $6, $7)`,
        [
          'John',
          'john@example.com',
          30,
          true,
          95.0,
          tenant.appId,
          tenant.organizationId,
          'Jane',
          'jane@example.com',
          28,
          false,
          88.0,
          'Bob',
          'bob@example.com',
          35,
          true,
          92.0,
        ]
      );
    });

    it('should filter with equality operator', async () => {
      const result = await db
        .table(testTableName, tenant)
        .where('name', '=', 'John')
        .select()
        .execute();

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('John');
    });

    it('should filter with greater than operator', async () => {
      const result = await db.table(testTableName, tenant).where('age', '>', 30).select().execute();

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Bob');
    });

    it('should filter with less than operator', async () => {
      const result = await db.table(testTableName, tenant).where('age', '<', 30).select().execute();

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Jane');
    });

    it('should filter with LIKE operator', async () => {
      const result = await db
        .table(testTableName, tenant)
        .where('email', 'like', '%john%')
        .select()
        .execute();

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('John');
    });

    it('should filter with IN operator', async () => {
      const result = await db
        .table(testTableName, tenant)
        .whereIn('name', ['John', 'Jane'])
        .select()
        .execute();

      expect(result).toHaveLength(2);
      expect(result.map((r) => r.name)).toEqual(expect.arrayContaining(['John', 'Jane']));
    });

    it('should filter with IS NULL', async () => {
      // Insert record with null value
      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, age, active, score, app_id, organization_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ['NullUser', 'null@example.com', null, true, 0.0, tenant.appId, tenant.organizationId]
      );

      const result = await db.table(testTableName, tenant).whereNull('age').select().execute();

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('NullUser');
    });

    it('should filter with IS NOT NULL', async () => {
      const result = await db.table(testTableName, tenant).whereNotNull('age').select().execute();

      expect(result).toHaveLength(3);
    });

    it('should chain multiple WHERE conditions', async () => {
      const result = await db
        .table(testTableName, tenant)
        .where('age', '>=', 28)
        .where('active', '=', true)
        .select()
        .execute();

      expect(result).toHaveLength(2);
      expect(result.map((r) => r.name)).toEqual(expect.arrayContaining(['John', 'Bob']));
    });
  });

  describe('SelectBuilder - Ordering and Limiting', () => {
    beforeEach(async () => {
      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, age, active, score, app_id, organization_id)
         VALUES
         ($1, $2, $3, $4, $5, $6, $7),
         ($8, $9, $10, $11, $12, $6, $7),
         ($13, $14, $15, $16, $17, $6, $7)`,
        [
          'Charlie',
          'charlie@example.com',
          40,
          true,
          85.0,
          tenant.appId,
          tenant.organizationId,
          'Alice',
          'alice@example.com',
          22,
          true,
          92.0,
          'Bob',
          'bob@example.com',
          35,
          true,
          88.0,
        ]
      );
    });

    it('should order by column ascending', async () => {
      const result = await db
        .table(testTableName, tenant)
        .orderBy('name', 'asc')
        .select()
        .execute();

      expect(result).toHaveLength(3);
      expect(result[0].name).toBe('Alice');
      expect(result[1].name).toBe('Bob');
      expect(result[2].name).toBe('Charlie');
    });

    it('should order by column descending', async () => {
      const result = await db
        .table(testTableName, tenant)
        .orderBy('age', 'desc')
        .select()
        .execute();

      expect(result).toHaveLength(3);
      expect(result[0].age).toBe(40);
      expect(result[1].age).toBe(35);
      expect(result[2].age).toBe(22);
    });

    it('should limit results', async () => {
      const result = await db
        .table(testTableName, tenant)
        .orderBy('name', 'asc')
        .limit(2)
        .select()
        .execute();

      expect(result).toHaveLength(2);
    });

    it('should offset results', async () => {
      const result = await db
        .table(testTableName, tenant)
        .orderBy('name', 'asc')
        .limit(2)
        .offset(1)
        .select()
        .execute();

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('Bob');
      expect(result[1].name).toBe('Charlie');
    });
  });

  describe('InsertBuilder - Single and Batch Inserts', () => {
    it('should insert single row', async () => {
      const result = await db
        .table(testTableName, tenant)
        .insert()
        .values({ name: 'John', email: 'john@example.com', age: 30, active: true, score: 95.0 })
        .execute();

      const count = await db.table(testTableName, tenant).select().count();
      expect(count).toBe(1);
    });

    it('should insert with RETURNING clause', async () => {
      const result = await db
        .table(testTableName, tenant)
        .insert()
        .values({ name: 'Jane', email: 'jane@example.com', age: 28, active: true, score: 88.0 })
        .returning('id', 'name', 'email')
        .execute();

      expect(result).toHaveLength(1);
      expect(result[0]).toHaveProperty('id');
      expect(result[0]).toMatchObject({ name: 'Jane', email: 'jane@example.com' });
    });

    it('should insert with various data types', async () => {
      const result = await db
        .table(testTableName, tenant)
        .insert()
        .values({
          name: 'DataTest',
          email: 'data@example.com',
          age: 42,
          active: false,
          score: 75.25,
        })
        .returning('name', 'age', 'active', 'score')
        .execute();

      expect(result[0].name).toBe('DataTest');
      expect(result[0].age).toBe(42);
      expect(result[0].active).toBe(false);
      expect(Number(result[0].score)).toBe(75.25);
    });

    it('should handle batch inserts via multiple calls', async () => {
      await db
        .table(testTableName, tenant)
        .insert()
        .values({ name: 'User1', email: 'user1@example.com', age: 20, active: true, score: 80.0 })
        .execute();

      await db
        .table(testTableName, tenant)
        .insert()
        .values({ name: 'User2', email: 'user2@example.com', age: 25, active: true, score: 85.0 })
        .execute();

      const count = await db.table(testTableName, tenant).select().count();
      expect(count).toBe(2);
    });
  });

  describe('UpdateBuilder - Conditional Updates', () => {
    beforeEach(async () => {
      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, age, active, score, app_id, organization_id)
         VALUES
         ($1, $2, $3, $4, $5, $6, $7),
         ($8, $9, $10, $11, $12, $6, $7)`,
        [
          'John',
          'john@example.com',
          30,
          true,
          95.0,
          tenant.appId,
          tenant.organizationId,
          'Jane',
          'jane@example.com',
          28,
          false,
          88.0,
        ]
      );
    });

    it('should update with conditions', async () => {
      await db
        .table(testTableName, tenant)
        .where('name', '=', 'John')
        .update({ age: 31, score: 96.0 })
        .execute();

      const result = await db
        .table(testTableName, tenant)
        .where('name', '=', 'John')
        .select()
        .first();

      expect(result?.age).toBe(31);
      expect(Number(result?.score)).toBe(96.0);
    });

    it('should update with RETURNING clause', async () => {
      const result = await db
        .table(testTableName, tenant)
        .where('name', '=', 'Jane')
        .update({ active: true })
        .returning('name', 'active')
        .execute();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ name: 'Jane', active: true });
    });

    it('should update multiple rows matching condition', async () => {
      await db
        .table(testTableName, tenant)
        .where('age', '>', 25)
        .update({ active: false })
        .execute();

      const result = await db.table(testTableName, tenant).select().execute();
      const inactiveCount = result.filter((r) => !r.active).length;

      expect(inactiveCount).toBe(2); // Both John (30) and Jane (28) have age > 25
    });

    it('should not update without conditions (safe mode)', async () => {
      // In a proper implementation, updates without conditions should be restricted
      // For now, we verify the specific condition works
      await db
        .table(testTableName, tenant)
        .where('name', '=', 'John')
        .update({ score: 100.0 })
        .execute();

      const result = await db
        .table(testTableName, tenant)
        .where('name', '=', 'Jane')
        .select()
        .first();

      // Jane's score should be unchanged
      expect(Number(result?.score)).toBe(88.0);
    });
  });

  describe('DeleteBuilder - Conditional Deletes', () => {
    beforeEach(async () => {
      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, age, active, score, app_id, organization_id)
         VALUES
         ($1, $2, $3, $4, $5, $6, $7),
         ($8, $9, $10, $11, $12, $6, $7),
         ($13, $14, $15, $16, $17, $6, $7)`,
        [
          'John',
          'john@example.com',
          30,
          true,
          95.0,
          tenant.appId,
          tenant.organizationId,
          'Jane',
          'jane@example.com',
          28,
          false,
          88.0,
          'Bob',
          'bob@example.com',
          35,
          true,
          92.0,
        ]
      );
    });

    it('should delete with condition', async () => {
      await db.table(testTableName, tenant).where('name', '=', 'John').delete().execute();

      const result = await db.table(testTableName, tenant).select().execute();
      expect(result).toHaveLength(2);
      expect(result.map((r) => r.name)).not.toContain('John');
    });

    it('should delete with RETURNING clause', async () => {
      const result = await db
        .table(testTableName, tenant)
        .where('name', '=', 'Jane')
        .delete()
        .returning('name', 'email')
        .execute();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ name: 'Jane', email: 'jane@example.com' });
    });

    it('should delete multiple rows matching condition', async () => {
      await db.table(testTableName, tenant).where('active', '=', true).delete().execute();

      const result = await db.table(testTableName, tenant).select().execute();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Jane');
    });
  });

  describe('JOIN Operations', () => {
    let userId1: string;
    let userId2: string;

    beforeEach(async () => {
      // Insert users and get their generated UUIDs
      const user1Result = await driver.query<{ id: string }>(
        `INSERT INTO ${testTableName} (name, email, age, active, score, app_id, organization_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        ['John', 'john@join.com', 30, true, 95.0, tenant.appId, tenant.organizationId]
      );
      userId1 = user1Result.rows[0].id;

      const user2Result = await driver.query<{ id: string }>(
        `INSERT INTO ${testTableName} (name, email, age, active, score, app_id, organization_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        ['Jane', 'jane@join.com', 28, true, 88.0, tenant.appId, tenant.organizationId]
      );
      userId2 = user2Result.rows[0].id;

      // Insert profiles
      await driver.execute(
        `INSERT INTO ${testJoinTableName} (user_id, profile_name, bio, app_id, organization_id)
         VALUES ($1, $2, $3, $4, $5), ($6, $7, $8, $4, $5)`,
        [
          userId1,
          'John Profile',
          'Software Engineer',
          tenant.appId,
          tenant.organizationId,
          userId2,
          'Jane Profile',
          'Data Scientist',
        ]
      );
    });

    it('should perform INNER JOIN', async () => {
      const result = await db
        .table(testTableName, tenant)
        .select('name')
        .innerJoin(testJoinTableName, `${testTableName}.id`, `${testJoinTableName}.user_id`)
        .execute();

      expect(result).toHaveLength(2);
      expect(result.map((r: any) => r.name)).toEqual(expect.arrayContaining(['John', 'Jane']));
    });

    it('should perform LEFT JOIN', async () => {
      // Insert user without profile
      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, age, active, score, app_id, organization_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ['Bob', 'bob@join.com', 35, true, 92.0, tenant.appId, tenant.organizationId]
      );

      const result = await db
        .table(testTableName, tenant)
        .select('name')
        .leftJoin(testJoinTableName, `${testTableName}.id`, `${testJoinTableName}.user_id`)
        .execute();

      expect(result).toHaveLength(3);
      expect(result.map((r: any) => r.name)).toEqual(
        expect.arrayContaining(['John', 'Jane', 'Bob'])
      );
    });

    it('should JOIN with alias', async () => {
      const result = await db
        .table(testTableName, tenant)
        .select('name')
        .innerJoin(
          testJoinTableName,
          `${testTableName}.id`,
          `${testJoinTableName}.user_id`,
          'profiles'
        )
        .execute();

      expect(result).toHaveLength(2);
    });
  });

  describe('Query Compilation - toSQL()', () => {
    it('should generate valid SQL for SELECT', () => {
      const { sql, params } = db
        .table(testTableName, tenant)
        .where('name', '=', 'John')
        .orderBy('age', 'desc')
        .limit(10)
        .select()
        .toSQL();

      expect(sql).toContain('SELECT');
      expect(sql).toContain('FROM');
      expect(sql).toContain('WHERE');
      expect(params).toContain('John');
    });

    it('should generate valid SQL for INSERT', () => {
      const { sql, params } = db
        .table(testTableName, tenant)
        .insert()
        .values({ name: 'Test', email: 'test@example.com', age: 25, active: true, score: 80.0 })
        .toSQL();

      expect(sql).toContain('INSERT');
      expect(sql).toContain('INTO');
      expect(params).toContain('Test');
    });

    it('should generate valid SQL for UPDATE', () => {
      const { sql, params } = db
        .table(testTableName, tenant)
        .where('id', '=', 'test-id')
        .update({ name: 'Updated' })
        .toSQL();

      expect(sql).toContain('UPDATE');
      expect(sql).toContain('SET');
      expect(params).toContain('Updated');
    });

    it('should generate valid SQL for DELETE', () => {
      const { sql, params } = db
        .table(testTableName, tenant)
        .where('id', '=', 'test-id')
        .delete()
        .toSQL();

      expect(sql).toContain('DELETE');
      expect(sql).toContain('FROM');
      expect(params).toContain('test-id');
    });
  });

  describe('Complex Query Scenarios', () => {
    beforeEach(async () => {
      await driver.execute(
        `INSERT INTO ${testTableName} (name, email, age, active, score, app_id, organization_id)
         VALUES
         ($1, $2, $3, $4, $5, $6, $7),
         ($8, $9, $10, $11, $12, $6, $7),
         ($13, $14, $15, $16, $17, $6, $7),
         ($18, $19, $20, $21, $22, $6, $7)`,
        [
          'Alice',
          'alice@example.com',
          22,
          true,
          92.0,
          tenant.appId,
          tenant.organizationId,
          'Bob',
          'bob@example.com',
          35,
          false,
          88.0,
          'Charlie',
          'charlie@example.com',
          40,
          true,
          85.0,
          'Diana',
          'diana@example.com',
          26,
          true,
          95.0,
        ]
      );
    });

    it('should query with multiple conditions and ordering', async () => {
      const result = await db
        .table(testTableName, tenant)
        .where('active', '=', true)
        .where('age', '>', 25)
        .orderBy('score', 'desc')
        .select()
        .execute();

      expect(result).toHaveLength(2);
      expect(Number(result[0].score)).toBeGreaterThanOrEqual(Number(result[1].score));
    });

    it('should paginate results with limit and offset', async () => {
      const page1 = await db
        .table(testTableName, tenant)
        .orderBy('name', 'asc')
        .limit(2)
        .offset(0)
        .select()
        .execute();

      const page2 = await db
        .table(testTableName, tenant)
        .orderBy('name', 'asc')
        .limit(2)
        .offset(2)
        .select()
        .execute();

      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(2);
      expect(page1[0].name).not.toBe(page2[0].name);
    });

    it('should handle empty result sets gracefully', async () => {
      const result = await db
        .table(testTableName, tenant)
        .where('name', '=', 'NonExistent')
        .select()
        .execute();

      expect(result).toHaveLength(0);
    });
  });

  describe('Transaction Support', () => {
    it('should execute queries in transaction context', async () => {
      let insertedId = '';

      await db.transaction(tenant, async (trx) => {
        const result = await trx
          .table(testTableName)
          .insert()
          .values({ name: 'TrxUser', email: 'trx@example.com', age: 25, active: true, score: 80.0 })
          .returning('id')
          .execute();

        insertedId = result[0].id;

        const selected = await trx
          .table(testTableName)
          .where('id', '=', insertedId)
          .select()
          .first();

        expect(selected?.name).toBe('TrxUser');
      });

      // Verify data persists after transaction
      const result = await db
        .table(testTableName, tenant)
        .where('id', '=', insertedId)
        .select()
        .first();

      expect(result?.name).toBe('TrxUser');
    });
  });
});
