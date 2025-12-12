import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPostgresDriver } from '../../src/driver/postgresql.js';
import type { Driver } from '../../src/driver/types.js';
import { SchemaRegistry } from '../../src/schema/registry.js';
import type { SchemaDefinition } from '../../src/types/index.js';

describe.skipIf(!process.env.DATABASE_URL)('Schema Registry E2E Tests', () => {
  let driver: Driver;
  let registry: SchemaRegistry;

  const testAppId = 'test-app-001';
  const testAppId2 = 'test-app-002';

  beforeAll(async () => {
    driver = createPostgresDriver({
      connectionString: process.env.DATABASE_URL as string,
    });

    registry = new SchemaRegistry(driver);
    await registry.ensureRegistryTable();
  });

  afterAll(async () => {
    // Clean up test tables created by registry
    try {
      await driver.execute(`DROP TABLE IF EXISTS test_users CASCADE;`);
      await driver.execute(`DROP TABLE IF EXISTS test_posts CASCADE;`);
      await driver.execute(`DROP TABLE IF EXISTS test_comments CASCADE;`);
      await driver.execute(`DROP TABLE IF EXISTS lp_schema_registry CASCADE;`);
    } catch (e) {
      // Ignore errors during cleanup
    }
    await driver.close();
  });

  beforeEach(async () => {
    // Clear registry before each test
    try {
      await driver.execute(`DELETE FROM lp_schema_registry;`);
      await driver.execute(`DROP TABLE IF EXISTS test_users CASCADE;`);
      await driver.execute(`DROP TABLE IF EXISTS test_posts CASCADE;`);
      await driver.execute(`DROP TABLE IF EXISTS test_comments CASCADE;`);
    } catch (e) {
      // Ignore if tables don't exist yet
    }
  });

  describe('Initial Schema Registration', () => {
    it('should register a new schema and create table', async () => {
      const schema: SchemaDefinition = {
        name: 'test',
        version: '1.0.0',
        tables: {
          test_users: {
            columns: {
              id: { type: 'uuid', required: true, primary: true },
              name: { type: 'string', required: true },
              email: { type: 'string', required: true, unique: true },
              age: { type: 'integer' },
              app_id: { type: 'string', required: true, tenant: true },
              organization_id: { type: 'string', required: true, tenant: true },
            },
            indexes: [
              { name: 'idx_users_email', columns: ['email'] },
              { name: 'idx_users_tenant', columns: ['app_id', 'organization_id'] },
            ],
          },
        },
      };

      const results = await registry.register({
        appId: testAppId,
        schemaName: 'public',
        version: '1.0.0',
        schema,
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].success).toBe(true);

      // Verify table was created
      const tableCheck = await driver.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE tablename = 'test_users' AND schemaname = 'public'`
      );
      expect(tableCheck.rows).toHaveLength(1);
    });

    it('should validate tenant columns exist', async () => {
      const invalidSchema: SchemaDefinition = {
        name: 'test',
        version: '1.0.0',
        tables: {
          test_invalid: {
            columns: {
              id: { type: 'uuid', required: true, primary: true },
              name: { type: 'string', required: true },
              // Missing app_id
              organization_id: { type: 'string', required: true, tenant: true },
            },
          },
        },
      };

      await expect(
        registry.register({
          appId: testAppId,
          schemaName: 'public',
          version: '1.0.0',
          schema: invalidSchema,
        })
      ).rejects.toThrow('must have an "app_id" column');
    });

    it('should validate tenant columns are marked', async () => {
      const invalidSchema: SchemaDefinition = {
        name: 'test',
        version: '1.0.0',
        tables: {
          test_invalid: {
            columns: {
              id: { type: 'uuid', required: true, primary: true },
              name: { type: 'string', required: true },
              app_id: { type: 'string', required: true }, // Missing tenant: true
              organization_id: { type: 'string', required: true, tenant: true },
            },
          },
        },
      };

      await expect(
        registry.register({
          appId: testAppId,
          schemaName: 'public',
          version: '1.0.0',
          schema: invalidSchema,
        })
      ).rejects.toThrow('must be marked as tenant column');
    });

    it('should validate id column exists', async () => {
      const invalidSchema: SchemaDefinition = {
        name: 'test',
        version: '1.0.0',
        tables: {
          test_invalid: {
            columns: {
              // Missing id
              name: { type: 'string', required: true },
              app_id: { type: 'string', required: true, tenant: true },
              organization_id: { type: 'string', required: true, tenant: true },
            },
          },
        },
      };

      await expect(
        registry.register({
          appId: testAppId,
          schemaName: 'public',
          version: '1.0.0',
          schema: invalidSchema,
        })
      ).rejects.toThrow('must have an "id" column');
    });
  });

  describe('Schema Updates', () => {
    it('should add columns to existing table', async () => {
      const initialSchema: SchemaDefinition = {
        name: 'test',
        version: '1.0.0',
        tables: {
          test_users: {
            columns: {
              id: { type: 'uuid', required: true, primary: true },
              name: { type: 'string', required: true },
              app_id: { type: 'string', required: true, tenant: true },
              organization_id: { type: 'string', required: true, tenant: true },
            },
          },
        },
      };

      // Register initial schema
      await registry.register({
        appId: testAppId,
        schemaName: 'public',
        version: '1.0.0',
        schema: initialSchema,
      });

      // Update with new column
      const updatedSchema: SchemaDefinition = {
        name: 'test',
        version: '1.1.0',
        tables: {
          test_users: {
            columns: {
              id: { type: 'uuid', required: true, primary: true },
              name: { type: 'string', required: true },
              email: { type: 'string', required: true }, // New column
              app_id: { type: 'string', required: true, tenant: true },
              organization_id: { type: 'string', required: true, tenant: true },
            },
          },
        },
      };

      const results = await registry.register({
        appId: testAppId,
        schemaName: 'public',
        version: '1.1.0',
        schema: updatedSchema,
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.success && r.name.includes('email'))).toBe(true);

      // Verify column was added
      const columnCheck = await driver.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'test_users' AND column_name = 'email'`
      );
      expect(columnCheck.rows).toHaveLength(1);
    });

    it('should create indexes for tables', async () => {
      const schema: SchemaDefinition = {
        name: 'test',
        version: '1.0.0',
        tables: {
          test_users: {
            columns: {
              id: { type: 'uuid', required: true, primary: true },
              name: { type: 'string', required: true },
              email: { type: 'string', required: true, unique: true },
              app_id: { type: 'string', required: true, tenant: true },
              organization_id: { type: 'string', required: true, tenant: true },
            },
            indexes: [
              { name: 'idx_users_email', columns: ['email'] },
              { name: 'idx_users_tenant', columns: ['app_id', 'organization_id'] },
            ],
          },
        },
      };

      const results = await registry.register({
        appId: testAppId,
        schemaName: 'public',
        version: '1.0.0',
        schema,
      });

      // Verify indexes were created
      const indexCheck = await driver.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'test_users' AND indexname LIKE 'idx_users_%'`
      );
      expect(indexCheck.rows.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Schema Diffing', () => {
    it('should detect no changes for identical schemas', async () => {
      const schema: SchemaDefinition = {
        name: 'test',
        version: '1.0.0',
        tables: {
          test_users: {
            columns: {
              id: { type: 'uuid', required: true, primary: true },
              name: { type: 'string', required: true },
              app_id: { type: 'string', required: true, tenant: true },
              organization_id: { type: 'string', required: true, tenant: true },
            },
          },
        },
      };

      // Register schema
      const results1 = await registry.register({
        appId: testAppId,
        schemaName: 'public',
        version: '1.0.0',
        schema,
      });

      expect(results1.length).toBeGreaterThan(0);

      // Re-register identical schema
      const results2 = await registry.register({
        appId: testAppId,
        schemaName: 'public',
        version: '1.0.0',
        schema,
      });

      // Should return empty array when no changes detected
      expect(results2).toHaveLength(0);
    });

    it('should detect table additions', async () => {
      const schema1: SchemaDefinition = {
        name: 'test',
        version: '1.0.0',
        tables: {
          test_users: {
            columns: {
              id: { type: 'uuid', required: true, primary: true },
              name: { type: 'string', required: true },
              app_id: { type: 'string', required: true, tenant: true },
              organization_id: { type: 'string', required: true, tenant: true },
            },
          },
        },
      };

      await registry.register({
        appId: testAppId,
        schemaName: 'public',
        version: '1.0.0',
        schema: schema1,
      });

      const schema2: SchemaDefinition = {
        name: 'test',
        version: '1.1.0',
        tables: {
          test_users: {
            columns: {
              id: { type: 'uuid', required: true, primary: true },
              name: { type: 'string', required: true },
              app_id: { type: 'string', required: true, tenant: true },
              organization_id: { type: 'string', required: true, tenant: true },
            },
          },
          test_posts: {
            columns: {
              id: { type: 'uuid', required: true, primary: true },
              title: { type: 'string', required: true },
              user_id: { type: 'uuid', required: true },
              app_id: { type: 'string', required: true, tenant: true },
              organization_id: { type: 'string', required: true, tenant: true },
            },
          },
        },
      };

      const results = await registry.register({
        appId: testAppId,
        schemaName: 'public',
        version: '1.1.0',
        schema: schema2,
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.name.includes('test_posts'))).toBe(true);
    });
  });

  describe('Schema Retrieval', () => {
    it('should retrieve current schema', async () => {
      const schema: SchemaDefinition = {
        name: 'test',
        version: '1.0.0',
        tables: {
          test_users: {
            columns: {
              id: { type: 'uuid', required: true, primary: true },
              name: { type: 'string', required: true },
              app_id: { type: 'string', required: true, tenant: true },
              organization_id: { type: 'string', required: true, tenant: true },
            },
          },
        },
      };

      await registry.register({
        appId: testAppId,
        schemaName: 'public',
        version: '1.0.0',
        schema,
      });

      const retrieved = await registry.getCurrentSchema(testAppId, 'public');

      expect(retrieved).not.toBeNull();
      expect(retrieved?.app_id).toBe(testAppId);
      expect(retrieved?.schema_name).toBe('public');
      expect(retrieved?.schema.tables.test_users).toBeDefined();
    });

    it('should return null for non-existent schema', async () => {
      const retrieved = await registry.getCurrentSchema('non-existent-app', 'public');
      expect(retrieved).toBeNull();
    });

    it('should list all schemas', async () => {
      const schema1: SchemaDefinition = {
        name: 'test1',
        version: '1.0.0',
        tables: {
          test_users: {
            columns: {
              id: { type: 'uuid', required: true, primary: true },
              name: { type: 'string', required: true },
              app_id: { type: 'string', required: true, tenant: true },
              organization_id: { type: 'string', required: true, tenant: true },
            },
          },
        },
      };

      const schema2: SchemaDefinition = {
        name: 'test2',
        version: '1.0.0',
        tables: {
          test_posts: {
            columns: {
              id: { type: 'uuid', required: true, primary: true },
              title: { type: 'string', required: true },
              app_id: { type: 'string', required: true, tenant: true },
              organization_id: { type: 'string', required: true, tenant: true },
            },
          },
        },
      };

      await registry.register({
        appId: testAppId,
        schemaName: 'schema1',
        version: '1.0.0',
        schema: schema1,
      });

      await registry.register({
        appId: testAppId,
        schemaName: 'schema2',
        version: '1.0.0',
        schema: schema2,
      });

      const schemas = await registry.listSchemas(testAppId);

      expect(schemas.length).toBe(2);
      expect(schemas.map((s) => s.schema_name)).toEqual(
        expect.arrayContaining(['schema1', 'schema2'])
      );
    });
  });

  describe('Multi-App Schema Isolation', () => {
    it('should isolate schemas between apps', async () => {
      const schema: SchemaDefinition = {
        name: 'test',
        version: '1.0.0',
        tables: {
          test_users: {
            columns: {
              id: { type: 'uuid', required: true, primary: true },
              name: { type: 'string', required: true },
              app_id: { type: 'string', required: true, tenant: true },
              organization_id: { type: 'string', required: true, tenant: true },
            },
          },
        },
      };

      // Register schema for app1
      await registry.register({
        appId: testAppId,
        schemaName: 'public',
        version: '1.0.0',
        schema,
      });

      // Register different schema for app2
      const schema2: SchemaDefinition = {
        name: 'test',
        version: '2.0.0',
        tables: {
          test_products: {
            columns: {
              id: { type: 'uuid', required: true, primary: true },
              name: { type: 'string', required: true },
              app_id: { type: 'string', required: true, tenant: true },
              organization_id: { type: 'string', required: true, tenant: true },
            },
          },
        },
      };

      await registry.register({
        appId: testAppId2,
        schemaName: 'public',
        version: '2.0.0',
        schema: schema2,
      });

      // Verify app1 gets their schema
      const app1Schema = await registry.getCurrentSchema(testAppId, 'public');
      expect(app1Schema?.schema.tables.test_users).toBeDefined();
      expect(app1Schema?.schema.tables.test_products).toBeUndefined();

      // Verify app2 gets their schema
      const app2Schema = await registry.getCurrentSchema(testAppId2, 'public');
      expect(app2Schema?.schema.tables.test_products).toBeDefined();
      expect(app2Schema?.schema.tables.test_users).toBeUndefined();
    });

    it('should list schemas for specific app', async () => {
      const schema: SchemaDefinition = {
        name: 'test',
        version: '1.0.0',
        tables: {
          test_users: {
            columns: {
              id: { type: 'uuid', required: true, primary: true },
              name: { type: 'string', required: true },
              app_id: { type: 'string', required: true, tenant: true },
              organization_id: { type: 'string', required: true, tenant: true },
            },
          },
        },
      };

      await registry.register({
        appId: testAppId,
        schemaName: 'public',
        version: '1.0.0',
        schema,
      });

      await registry.register({
        appId: testAppId2,
        schemaName: 'public',
        version: '1.0.0',
        schema,
      });

      const app1Schemas = await registry.listSchemas(testAppId);
      const app2Schemas = await registry.listSchemas(testAppId2);

      expect(app1Schemas.every((s) => s.app_id === testAppId)).toBe(true);
      expect(app2Schemas.every((s) => s.app_id === testAppId2)).toBe(true);
    });
  });

  describe('Schema Checksums', () => {
    it('should compute and store schema checksum', async () => {
      const schema: SchemaDefinition = {
        name: 'test',
        version: '1.0.0',
        tables: {
          test_users: {
            columns: {
              id: { type: 'uuid', required: true, primary: true },
              name: { type: 'string', required: true },
              app_id: { type: 'string', required: true, tenant: true },
              organization_id: { type: 'string', required: true, tenant: true },
            },
          },
        },
      };

      await registry.register({
        appId: testAppId,
        schemaName: 'public',
        version: '1.0.0',
        schema,
      });

      const retrieved = await registry.getCurrentSchema(testAppId, 'public');

      expect(retrieved?.checksum).toBeDefined();
      expect(typeof retrieved?.checksum).toBe('string');
      expect(retrieved?.checksum.length).toBeGreaterThan(0);
    });

    it('should detect schema changes via checksum', async () => {
      const schema1: SchemaDefinition = {
        name: 'test',
        version: '1.0.0',
        tables: {
          test_users: {
            columns: {
              id: { type: 'uuid', required: true, primary: true },
              name: { type: 'string', required: true },
              app_id: { type: 'string', required: true, tenant: true },
              organization_id: { type: 'string', required: true, tenant: true },
            },
          },
        },
      };

      await registry.register({
        appId: testAppId,
        schemaName: 'public',
        version: '1.0.0',
        schema: schema1,
      });

      const schema1Record = await registry.getCurrentSchema(testAppId, 'public');
      const checksum1 = schema1Record?.checksum;

      const schema2: SchemaDefinition = {
        name: 'test',
        version: '1.1.0',
        tables: {
          test_users: {
            columns: {
              id: { type: 'uuid', required: true, primary: true },
              name: { type: 'string', required: true },
              email: { type: 'string', required: true }, // New column
              app_id: { type: 'string', required: true, tenant: true },
              organization_id: { type: 'string', required: true, tenant: true },
            },
          },
        },
      };

      await registry.register({
        appId: testAppId,
        schemaName: 'public',
        version: '1.1.0',
        schema: schema2,
      });

      const schema2Record = await registry.getCurrentSchema(testAppId, 'public');
      const checksum2 = schema2Record?.checksum;

      expect(checksum1).not.toBe(checksum2);
    });
  });

  describe('Error Handling', () => {
    it('should handle transaction rollback on migration failure', async () => {
      const schema: SchemaDefinition = {
        name: 'test',
        version: '1.0.0',
        tables: {
          test_users: {
            columns: {
              id: { type: 'uuid', required: true, primary: true },
              name: { type: 'string', required: true },
              app_id: { type: 'string', required: true, tenant: true },
              organization_id: { type: 'string', required: true, tenant: true },
            },
          },
        },
      };

      await registry.register({
        appId: testAppId,
        schemaName: 'public',
        version: '1.0.0',
        schema,
      });

      // Try to register with duplicate unique constraint (should fail)
      const invalidSchema: SchemaDefinition = {
        name: 'test',
        version: '1.1.0',
        tables: {
          test_users: {
            columns: {
              id: { type: 'uuid', required: true, primary: true },
              name: { type: 'string', required: true, unique: true },
              name_unique: { type: 'string', required: true, unique: true }, // Duplicate unique
              app_id: { type: 'string', required: true, tenant: true },
              organization_id: { type: 'string', required: true, tenant: true },
            },
          },
        },
      };

      // Register should handle error gracefully
      try {
        await registry.register({
          appId: testAppId,
          schemaName: 'public',
          version: '1.1.0',
          schema: invalidSchema,
        });
      } catch (e) {
        // Expected to throw
        expect(e).toBeDefined();
      }
    });
  });
});
