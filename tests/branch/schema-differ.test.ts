import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createDriver } from '../../src/driver/index.js';
import type { Driver } from '../../src/driver/types.js';
import { SchemaDiffer } from '../../src/branch/schema-differ.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/launchpad_test';

describe('SchemaDiffer', () => {
  let driver: Driver;
  let differ: SchemaDiffer;
  const testSchemas: string[] = [];

  beforeAll(async () => {
    driver = await createDriver({ connectionString: TEST_DB_URL });
    differ = new SchemaDiffer(driver);
  });

  afterAll(async () => {
    for (const schema of testSchemas) {
      try {
        await driver.execute(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } catch {
      }
    }
    await driver.close();
  });

  async function createTestSchema(name: string): Promise<string> {
    const schemaName = `test_${name}_${Date.now()}`;
    await driver.execute(`CREATE SCHEMA ${schemaName}`);
    testSchemas.push(schemaName);
    return schemaName;
  }

  describe('diff', () => {
    it('should detect no changes for identical schemas', async () => {
      const schema1 = await createTestSchema('identical1');
      const schema2 = await createTestSchema('identical2');

      await driver.execute(`CREATE TABLE ${schema1}.users (id SERIAL PRIMARY KEY, name TEXT)`);
      await driver.execute(`CREATE TABLE ${schema2}.users (id SERIAL PRIMARY KEY, name TEXT)`);

      const diff = await differ.diff(schema1, schema2);

      expect(diff.hasChanges).toBe(false);
      expect(diff.canAutoMerge).toBe(true);
      expect(diff.tables).toHaveLength(0);
      expect(diff.columns).toHaveLength(0);
    });

    it('should detect added tables', async () => {
      const schema1 = await createTestSchema('added_table1');
      const schema2 = await createTestSchema('added_table2');

      await driver.execute(`CREATE TABLE ${schema1}.users (id SERIAL PRIMARY KEY)`);
      await driver.execute(`CREATE TABLE ${schema1}.orders (id SERIAL PRIMARY KEY)`);
      await driver.execute(`CREATE TABLE ${schema2}.users (id SERIAL PRIMARY KEY)`);

      const diff = await differ.diff(schema1, schema2);

      expect(diff.hasChanges).toBe(true);
      expect(diff.tables).toContainEqual(
        expect.objectContaining({
          name: 'orders',
          action: 'added',
        })
      );
    });

    it('should detect removed tables', async () => {
      const schema1 = await createTestSchema('removed_table1');
      const schema2 = await createTestSchema('removed_table2');

      await driver.execute(`CREATE TABLE ${schema1}.users (id SERIAL PRIMARY KEY)`);
      await driver.execute(`CREATE TABLE ${schema2}.users (id SERIAL PRIMARY KEY)`);
      await driver.execute(`CREATE TABLE ${schema2}.products (id SERIAL PRIMARY KEY)`);

      const diff = await differ.diff(schema1, schema2);

      expect(diff.hasChanges).toBe(true);
      expect(diff.tables).toContainEqual(
        expect.objectContaining({
          name: 'products',
          action: 'removed',
        })
      );
    });

    it('should detect added columns', async () => {
      const schema1 = await createTestSchema('added_col1');
      const schema2 = await createTestSchema('added_col2');

      await driver.execute(`CREATE TABLE ${schema1}.users (id SERIAL PRIMARY KEY, name TEXT, email TEXT)`);
      await driver.execute(`CREATE TABLE ${schema2}.users (id SERIAL PRIMARY KEY, name TEXT)`);

      const diff = await differ.diff(schema1, schema2);

      expect(diff.hasChanges).toBe(true);
      expect(diff.columns).toContainEqual(
        expect.objectContaining({
          tableName: 'users',
          columnName: 'email',
          action: 'added',
        })
      );
    });

    it('should detect removed columns', async () => {
      const schema1 = await createTestSchema('removed_col1');
      const schema2 = await createTestSchema('removed_col2');

      await driver.execute(`CREATE TABLE ${schema1}.users (id SERIAL PRIMARY KEY)`);
      await driver.execute(`CREATE TABLE ${schema2}.users (id SERIAL PRIMARY KEY, age INTEGER)`);

      const diff = await differ.diff(schema1, schema2);

      expect(diff.hasChanges).toBe(true);
      expect(diff.columns).toContainEqual(
        expect.objectContaining({
          tableName: 'users',
          columnName: 'age',
          action: 'removed',
          isBreaking: true,
        })
      );
    });

    it('should detect column type changes', async () => {
      const schema1 = await createTestSchema('type_change1');
      const schema2 = await createTestSchema('type_change2');

      await driver.execute(`CREATE TABLE ${schema1}.users (id SERIAL PRIMARY KEY, age INTEGER)`);
      await driver.execute(`CREATE TABLE ${schema2}.users (id SERIAL PRIMARY KEY, age TEXT)`);

      const diff = await differ.diff(schema1, schema2);

      expect(diff.hasChanges).toBe(true);
      expect(diff.columns).toContainEqual(
        expect.objectContaining({
          tableName: 'users',
          columnName: 'age',
          action: 'modified',
          sourceType: expect.stringContaining('INT'),
          targetType: 'TEXT',
        })
      );
    });

    it('should detect added indexes', async () => {
      const schema1 = await createTestSchema('added_idx1');
      const schema2 = await createTestSchema('added_idx2');

      await driver.execute(`CREATE TABLE ${schema1}.users (id SERIAL PRIMARY KEY, email TEXT)`);
      await driver.execute(`CREATE INDEX idx_users_email ON ${schema1}.users (email)`);
      await driver.execute(`CREATE TABLE ${schema2}.users (id SERIAL PRIMARY KEY, email TEXT)`);

      const diff = await differ.diff(schema1, schema2);

      expect(diff.hasChanges).toBe(true);
      expect(diff.indexes).toContainEqual(
        expect.objectContaining({
          tableName: 'users',
          indexName: 'idx_users_email',
          action: 'added',
        })
      );
    });

    it('should detect conflicts for type mismatches', async () => {
      const schema1 = await createTestSchema('conflict1');
      const schema2 = await createTestSchema('conflict2');

      await driver.execute(`CREATE TABLE ${schema1}.users (id SERIAL PRIMARY KEY, status VARCHAR(20))`);
      await driver.execute(`CREATE TABLE ${schema2}.users (id SERIAL PRIMARY KEY, status INTEGER)`);

      const diff = await differ.diff(schema1, schema2);

      expect(diff.canAutoMerge).toBe(false);
      expect(diff.conflicts).toContainEqual(
        expect.objectContaining({
          type: 'column_type_mismatch',
          description: expect.stringContaining('status'),
        })
      );
    });

    it('should generate forward SQL for changes', async () => {
      const schema1 = await createTestSchema('sql_gen1');
      const schema2 = await createTestSchema('sql_gen2');

      await driver.execute(`CREATE TABLE ${schema1}.users (id SERIAL PRIMARY KEY, name TEXT, email TEXT)`);
      await driver.execute(`CREATE TABLE ${schema2}.users (id SERIAL PRIMARY KEY, name TEXT)`);

      const diff = await differ.diff(schema1, schema2);

      expect(diff.forwardSql.length).toBeGreaterThan(0);
      expect(diff.forwardSql.some((sql) => sql.includes('ADD COLUMN') && sql.includes('email'))).toBe(true);
    });

    it('should generate reverse SQL for changes', async () => {
      const schema1 = await createTestSchema('reverse_sql1');
      const schema2 = await createTestSchema('reverse_sql2');

      await driver.execute(`CREATE TABLE ${schema1}.users (id SERIAL PRIMARY KEY, name TEXT, email TEXT)`);
      await driver.execute(`CREATE TABLE ${schema2}.users (id SERIAL PRIMARY KEY, name TEXT)`);

      const diff = await differ.diff(schema1, schema2);

      expect(diff.reverseSql.length).toBeGreaterThan(0);
      expect(diff.reverseSql.some((sql) => sql.includes('DROP COLUMN') && sql.includes('email'))).toBe(true);
    });
  });
});
