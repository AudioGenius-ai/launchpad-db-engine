import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDbClient } from '../../src/client.js';
import type { DbClient } from '../../src/client.js';
import { createSQLiteDriver } from '../../src/driver/sqlite.js';
import type { Driver } from '../../src/driver/types.js';

describe('SQLite Driver Integration', () => {
  let driver: Driver;
  const testTableName = 'test_integration_users';

  beforeAll(async () => {
    driver = await createSQLiteDriver({
      connectionString: ':memory:',
    });

    await driver.execute(`
      CREATE TABLE IF NOT EXISTS ${testTableName} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        age INTEGER,
        app_id TEXT,
        organization_id TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
  });

  afterAll(async () => {
    await driver.close();
  });

  describe('Database Connection', () => {
    it('should connect to SQLite database', async () => {
      const result = await driver.query('SELECT 1 as connected');
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toEqual({ connected: 1 });
    });
  });

  describe('Basic Query Execution', () => {
    it('should execute a simple SELECT query', async () => {
      const result = await driver.query("SELECT datetime('now') as current_time");
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toHaveProperty('current_time');
      expect(result.rowCount).toBe(1);
    });

    it('should insert data and return row count', async () => {
      const result = await driver.execute(
        `INSERT INTO ${testTableName} (name, email, age) VALUES (?, ?, ?)`,
        ['John Doe', 'john@example.com', 30]
      );
      expect(result.rowCount).toBeGreaterThan(0);
    });

    it('should query inserted data', async () => {
      const result = await driver.query<{ name: string; email: string; age: number }>(
        `SELECT name, email, age FROM ${testTableName} WHERE email = ?`,
        ['john@example.com']
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({
        name: 'John Doe',
        email: 'john@example.com',
        age: 30,
      });
    });
  });

  describe('Parameterized Queries', () => {
    it('should handle parameterized INSERT queries', async () => {
      const result = await driver.execute(
        `INSERT INTO ${testTableName} (name, email, age) VALUES (?, ?, ?)`,
        ['Jane Smith', 'jane@example.com', 25]
      );
      expect(result.rowCount).toBe(1);

      const inserted = await driver.query<{ id: number; name: string }>(
        `SELECT id, name FROM ${testTableName} WHERE email = ?`,
        ['jane@example.com']
      );
      expect(inserted.rows).toHaveLength(1);
      expect(inserted.rows[0]).toHaveProperty('id');
      expect(inserted.rows[0].name).toBe('Jane Smith');
    });

    it('should handle parameterized UPDATE queries', async () => {
      const result = await driver.execute(`UPDATE ${testTableName} SET age = ? WHERE email = ?`, [
        26,
        'jane@example.com',
      ]);
      expect(result.rowCount).toBe(1);

      const updated = await driver.query<{ age: number }>(
        `SELECT age FROM ${testTableName} WHERE email = ?`,
        ['jane@example.com']
      );
      expect(updated.rows[0].age).toBe(26);
    });

    it('should handle parameterized DELETE queries', async () => {
      await driver.execute(`INSERT INTO ${testTableName} (name, email, age) VALUES (?, ?, ?)`, [
        'Temp User',
        'temp@example.com',
        99,
      ]);

      const result = await driver.execute(`DELETE FROM ${testTableName} WHERE email = ?`, [
        'temp@example.com',
      ]);
      expect(result.rowCount).toBe(1);

      const check = await driver.query(`SELECT * FROM ${testTableName} WHERE email = ?`, [
        'temp@example.com',
      ]);
      expect(check.rows).toHaveLength(0);
    });
  });

  describe('Transactions', () => {
    it('should commit a transaction successfully', async () => {
      const result = await driver.transaction(async (trx) => {
        await trx.execute(`INSERT INTO ${testTableName} (name, email, age) VALUES (?, ?, ?)`, [
          'Alice Brown',
          'alice@example.com',
          35,
        ]);

        await trx.execute(`INSERT INTO ${testTableName} (name, email, age) VALUES (?, ?, ?)`, [
          'Bob White',
          'bob@example.com',
          40,
        ]);

        const count = await trx.query<{ count: number }>(
          `SELECT COUNT(*) as count FROM ${testTableName} WHERE email IN (?, ?)`,
          ['alice@example.com', 'bob@example.com']
        );

        return Number(count.rows[0].count);
      });

      expect(result).toBe(2);

      const verify = await driver.query(`SELECT * FROM ${testTableName} WHERE email IN (?, ?)`, [
        'alice@example.com',
        'bob@example.com',
      ]);
      expect(verify.rows).toHaveLength(2);
    });

    it('should rollback a transaction on error', async () => {
      const initialCount = await driver.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM ${testTableName}`
      );
      const startCount = Number(initialCount.rows[0].count);

      await expect(async () => {
        await driver.transaction(async (trx) => {
          await trx.execute(`INSERT INTO ${testTableName} (name, email, age) VALUES (?, ?, ?)`, [
            'Charlie Green',
            'charlie@example.com',
            28,
          ]);

          throw new Error('Intentional rollback');
        });
      }).rejects.toThrow('Intentional rollback');

      const finalCount = await driver.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM ${testTableName}`
      );
      expect(Number(finalCount.rows[0].count)).toBe(startCount);

      const verify = await driver.query(`SELECT * FROM ${testTableName} WHERE email = ?`, [
        'charlie@example.com',
      ]);
      expect(verify.rows).toHaveLength(0);
    });

    it('should handle unique constraint violation and rollback', async () => {
      await driver.execute(`INSERT INTO ${testTableName} (name, email, age) VALUES (?, ?, ?)`, [
        'David Black',
        'david@example.com',
        33,
      ]);

      await expect(async () => {
        await driver.transaction(async (trx) => {
          await trx.execute(`INSERT INTO ${testTableName} (name, email, age) VALUES (?, ?, ?)`, [
            'David Clone',
            'david@example.com',
            34,
          ]);
        });
      }).rejects.toThrow();
    });
  });
});

describe('DbClient SQLite Integration', () => {
  let driver: Driver;
  let client: DbClient;
  const testTableName = 'test_client_products';

  beforeAll(async () => {
    driver = await createSQLiteDriver({
      connectionString: ':memory:',
    });

    client = createDbClient(driver, {
      tenantColumns: {
        appId: 'app_id',
        organizationId: 'organization_id',
      },
    });

    await driver.execute(`
      CREATE TABLE IF NOT EXISTS ${testTableName} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        price REAL,
        app_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
  });

  afterAll(async () => {
    await client.close();
  });

  describe('DbClient.table() method', () => {
    it('should create a table builder with tenant context', async () => {
      const ctx = { appId: 'app-123', organizationId: 'org-456' };
      const table = client.table(testTableName, ctx);

      expect(table).toBeDefined();
      expect(typeof table.insert).toBe('function');
      expect(typeof table.select).toBe('function');
    });
  });

  describe('DbClient.transaction() with tenant context', () => {
    it('should execute operations within transaction', async () => {
      const ctx = { appId: 'app-tx-123', organizationId: 'org-tx-456' };

      await client.transaction(ctx, async (trx) => {
        await trx.execute(
          `INSERT INTO ${testTableName} (name, price, app_id, organization_id) VALUES (?, ?, ?, ?)`,
          ['Transaction Product', 99.99, ctx.appId, ctx.organizationId]
        );
      });

      const verify = await driver.query(`SELECT * FROM ${testTableName} WHERE app_id = ?`, [
        ctx.appId,
      ]);
      expect(verify.rows).toHaveLength(1);
    });

    it('should rollback transaction on error', async () => {
      const ctx = { appId: 'app-rollback', organizationId: 'org-rollback' };

      await expect(async () => {
        await client.transaction(ctx, async (trx) => {
          await trx.execute(
            `INSERT INTO ${testTableName} (name, price, app_id, organization_id) VALUES (?, ?, ?, ?)`,
            ['Failed Product', 88.88, ctx.appId, ctx.organizationId]
          );
          throw new Error('Force rollback');
        });
      }).rejects.toThrow('Force rollback');

      const verify = await driver.query(`SELECT * FROM ${testTableName} WHERE name = ?`, [
        'Failed Product',
      ]);
      expect(verify.rows).toHaveLength(0);
    });

    it('should support nested operations within transaction', async () => {
      const ctx = { appId: 'app-nested', organizationId: 'org-nested' };

      await client.transaction(ctx, async (trx) => {
        await trx.execute(
          `INSERT INTO ${testTableName} (name, price, app_id, organization_id) VALUES (?, ?, ?, ?)`,
          ['Product A', 10.0, ctx.appId, ctx.organizationId]
        );

        await trx.execute(
          `INSERT INTO ${testTableName} (name, price, app_id, organization_id) VALUES (?, ?, ?, ?)`,
          ['Product B', 20.0, ctx.appId, ctx.organizationId]
        );
      });

      const verify = await driver.query(
        `SELECT * FROM ${testTableName} WHERE app_id = ? AND organization_id = ?`,
        [ctx.appId, ctx.organizationId]
      );
      expect(verify.rows).toHaveLength(2);
    });
  });

  describe('DbClient raw query methods', () => {
    it('should execute raw queries with client.raw()', async () => {
      const result = await client.raw<{ test: number }>('SELECT 42 as test');
      expect(result.rows[0].test).toBe(42);
    });

    it('should execute raw queries with parameters', async () => {
      const result = await client.raw<{ sum: number }>('SELECT ? + ? as sum', [10, 20]);
      expect(result.rows[0].sum).toBe(30);
    });

    it('should execute commands with client.execute()', async () => {
      const result = await client.execute(
        `INSERT INTO ${testTableName} (name, price, app_id, organization_id) VALUES (?, ?, ?, ?)`,
        ['Raw Product', 55.55, 'app-raw', 'org-raw']
      );
      expect(result.rowCount).toBeGreaterThan(0);
    });
  });
});
