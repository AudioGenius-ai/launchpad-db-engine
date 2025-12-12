import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Driver, QueryResult } from '../driver/types.js';
import type { SchemaDefinition, TableDefinition } from '../types/index.js';
import { SchemaRegistry, createSchemaRegistry } from './registry.js';

// Track all execute calls across driver and transactions
let allExecuteCalls: Array<[string, unknown[]?]> = [];

function createMockDriver(dialect: 'postgresql' | 'mysql' | 'sqlite' = 'postgresql'): Driver {
  allExecuteCalls = [];

  const mockExecute = vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
    allExecuteCalls.push([sql, params]);
    return { rowCount: 0 };
  });

  return {
    dialect,
    connectionString: 'mock://localhost/test',
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    execute: mockExecute,
    transaction: vi.fn().mockImplementation(async (fn) => {
      const trx = {
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        execute: vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
          allExecuteCalls.push([sql, params]);
          return { rowCount: 0 };
        }),
      };
      return fn(trx);
    }),
    close: vi.fn(),
  };
}

function createValidSchema(): SchemaDefinition {
  return {
    tables: {
      users: {
        columns: {
          id: { type: 'uuid', nullable: false, primaryKey: true },
          app_id: { type: 'uuid', nullable: false, tenant: true },
          organization_id: { type: 'uuid', nullable: false, tenant: true },
          name: { type: 'string', nullable: false },
          email: { type: 'string', nullable: false, unique: true },
          created_at: { type: 'datetime', nullable: false, default: 'now()' },
        },
      },
    },
  };
}

describe('SchemaRegistry', () => {
  describe('validateSchema', () => {
    let driver: Driver;

    beforeEach(() => {
      driver = createMockDriver();
    });

    it('should throw if table missing app_id column', async () => {
      const registry = createSchemaRegistry(driver);
      const schema: SchemaDefinition = {
        tables: {
          users: {
            columns: {
              id: { type: 'uuid', nullable: false },
              organization_id: { type: 'uuid', nullable: false, tenant: true },
            },
          },
        },
      };

      await expect(
        registry.register({
          appId: 'test-app',
          schemaName: 'test',
          version: '1.0.0',
          schema,
        })
      ).rejects.toThrow('must have an "app_id" column');
    });

    it('should throw if table missing organization_id column', async () => {
      const registry = createSchemaRegistry(driver);
      const schema: SchemaDefinition = {
        tables: {
          users: {
            columns: {
              id: { type: 'uuid', nullable: false },
              app_id: { type: 'uuid', nullable: false, tenant: true },
            },
          },
        },
      };

      await expect(
        registry.register({
          appId: 'test-app',
          schemaName: 'test',
          version: '1.0.0',
          schema,
        })
      ).rejects.toThrow('must have an "organization_id" column');
    });

    it('should throw if table missing id column', async () => {
      const registry = createSchemaRegistry(driver);
      const schema: SchemaDefinition = {
        tables: {
          users: {
            columns: {
              app_id: { type: 'uuid', nullable: false, tenant: true },
              organization_id: { type: 'uuid', nullable: false, tenant: true },
            },
          },
        },
      };

      await expect(
        registry.register({
          appId: 'test-app',
          schemaName: 'test',
          version: '1.0.0',
          schema,
        })
      ).rejects.toThrow('must have an "id" column');
    });

    it('should throw if app_id not marked as tenant column', async () => {
      const registry = createSchemaRegistry(driver);
      const schema: SchemaDefinition = {
        tables: {
          users: {
            columns: {
              id: { type: 'uuid', nullable: false },
              app_id: { type: 'uuid', nullable: false }, // Missing tenant: true
              organization_id: { type: 'uuid', nullable: false, tenant: true },
            },
          },
        },
      };

      await expect(
        registry.register({
          appId: 'test-app',
          schemaName: 'test',
          version: '1.0.0',
          schema,
        })
      ).rejects.toThrow('must be marked as tenant column');
    });

    it('should throw if organization_id not marked as tenant column', async () => {
      const registry = createSchemaRegistry(driver);
      const schema: SchemaDefinition = {
        tables: {
          users: {
            columns: {
              id: { type: 'uuid', nullable: false },
              app_id: { type: 'uuid', nullable: false, tenant: true },
              organization_id: { type: 'uuid', nullable: false }, // Missing tenant: true
            },
          },
        },
      };

      await expect(
        registry.register({
          appId: 'test-app',
          schemaName: 'test',
          version: '1.0.0',
          schema,
        })
      ).rejects.toThrow('must be marked as tenant column');
    });

    it('should accept valid schema with all required columns', async () => {
      const registry = createSchemaRegistry(driver);
      const schema = createValidSchema();

      await expect(
        registry.register({
          appId: 'test-app',
          schemaName: 'test',
          version: '1.0.0',
          schema,
        })
      ).resolves.toBeDefined();
    });
  });

  describe('computeChecksum', () => {
    let driver: Driver;

    beforeEach(() => {
      driver = createMockDriver();
    });

    it('should compute consistent checksum for same schema', async () => {
      const registry = createSchemaRegistry(driver);
      const schema1 = createValidSchema();
      const schema2 = createValidSchema();

      await registry.register({
        appId: 'test-app',
        schemaName: 'test1',
        version: '1.0.0',
        schema: schema1,
      });

      const upsert1 = allExecuteCalls.find(
        (c) => c[0].includes('INSERT INTO') && c[0].includes('lp_schema_registry')
      );

      // Reset and register same schema
      allExecuteCalls = [];
      const driver2 = createMockDriver();
      const registry2 = createSchemaRegistry(driver2);

      await registry2.register({
        appId: 'test-app',
        schemaName: 'test2',
        version: '1.0.0',
        schema: schema2,
      });

      const upsert2 = allExecuteCalls.find(
        (c) => c[0].includes('INSERT INTO') && c[0].includes('lp_schema_registry')
      );

      // Checksums should match - checksum is the 5th parameter
      expect(upsert1).toBeDefined();
      expect(upsert2).toBeDefined();
      expect(upsert1![1]![4]).toBe(upsert2![1]![4]);
    });

    it('should compute different checksum for different schemas', async () => {
      const registry = createSchemaRegistry(driver);
      const schema1 = createValidSchema();

      await registry.register({
        appId: 'test-app',
        schemaName: 'test1',
        version: '1.0.0',
        schema: schema1,
      });

      const upsert1 = allExecuteCalls.find(
        (c) => c[0].includes('INSERT INTO') && c[0].includes('lp_schema_registry')
      );
      const checksum1 = upsert1?.[1]?.[4];

      // Create new driver and registry for different schema
      allExecuteCalls = [];
      const driver2 = createMockDriver();
      const registry2 = createSchemaRegistry(driver2);
      const schema2 = createValidSchema();
      schema2.tables.users.columns.extra = { type: 'string', nullable: true };

      await registry2.register({
        appId: 'test-app',
        schemaName: 'test2',
        version: '1.0.0',
        schema: schema2,
      });

      const upsert2 = allExecuteCalls.find(
        (c) => c[0].includes('INSERT INTO') && c[0].includes('lp_schema_registry')
      );
      const checksum2 = upsert2?.[1]?.[4];

      expect(checksum1).toBeDefined();
      expect(checksum2).toBeDefined();
      expect(checksum1).not.toBe(checksum2);
    });

    it('should compute 64-character hex checksum', async () => {
      const registry = createSchemaRegistry(driver);
      const schema = createValidSchema();

      await registry.register({
        appId: 'test-app',
        schemaName: 'test',
        version: '1.0.0',
        schema,
      });

      const upsert = allExecuteCalls.find(
        (c) => c[0].includes('INSERT INTO') && c[0].includes('lp_schema_registry')
      );
      const checksum = upsert?.[1]?.[4] as string;

      expect(checksum).toBeDefined();
      expect(checksum).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('computeDiff', () => {
    let driver: Driver;

    beforeEach(() => {
      driver = createMockDriver();
    });

    it('should detect new table', async () => {
      const registry = createSchemaRegistry(driver);
      const schema = createValidSchema();

      await registry.register({
        appId: 'test-app',
        schemaName: 'test',
        version: '1.0.0',
        schema,
      });

      // Should have CREATE TABLE in the changes (not the registry table)
      const createCall = allExecuteCalls.find(
        (c) => c[0].includes('CREATE TABLE') && c[0].includes('"users"')
      );
      expect(createCall).toBeDefined();
    });

    it('should detect added column', async () => {
      const registry = createSchemaRegistry(driver);

      // First register
      const schema1 = createValidSchema();
      (driver.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      });

      await registry.register({
        appId: 'test-app',
        schemaName: 'test',
        version: '1.0.0',
        schema: schema1,
      });

      // Clear tracked calls
      allExecuteCalls = [];

      // Mock existing schema for second register
      (driver.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [
          {
            app_id: 'test-app',
            schema_name: 'test',
            version: '1.0.0',
            schema: JSON.stringify(schema1),
            checksum: 'abc123',
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
        rowCount: 1,
      });

      // Add a column
      const schema2 = createValidSchema();
      schema2.tables.users.columns.phone = { type: 'string', nullable: true };

      await registry.register({
        appId: 'test-app',
        schemaName: 'test',
        version: '1.1.0',
        schema: schema2,
      });

      // Should have ALTER TABLE ADD COLUMN
      const addColCall = allExecuteCalls.find(
        (c) => c[0].includes('ADD COLUMN') && c[0].includes('phone')
      );
      expect(addColCall).toBeDefined();
    });

    it('should detect dropped column', async () => {
      const registry = createSchemaRegistry(driver);

      // Start with extra column
      const schema1 = createValidSchema();
      schema1.tables.users.columns.phone = { type: 'string', nullable: true };

      (driver.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [
          {
            app_id: 'test-app',
            schema_name: 'test',
            version: '1.0.0',
            schema: JSON.stringify(schema1),
            checksum: 'abc123',
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
        rowCount: 1,
      });

      // Remove the column
      const schema2 = createValidSchema();

      await registry.register({
        appId: 'test-app',
        schemaName: 'test',
        version: '1.1.0',
        schema: schema2,
      });

      // Should have DROP COLUMN
      const dropColCall = allExecuteCalls.find(
        (c) => c[0].includes('DROP COLUMN') && c[0].includes('phone')
      );
      expect(dropColCall).toBeDefined();
    });

    it('should detect altered column (type change)', async () => {
      const registry = createSchemaRegistry(driver);

      const schema1 = createValidSchema();
      schema1.tables.users.columns.age = { type: 'integer', nullable: true };

      (driver.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [
          {
            app_id: 'test-app',
            schema_name: 'test',
            version: '1.0.0',
            schema: JSON.stringify(schema1),
            checksum: 'abc123',
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
        rowCount: 1,
      });

      // Change column type
      const schema2 = createValidSchema();
      schema2.tables.users.columns.age = { type: 'bigint', nullable: true };

      await registry.register({
        appId: 'test-app',
        schemaName: 'test',
        version: '1.1.0',
        schema: schema2,
      });

      // Should have ALTER COLUMN
      const alterColCall = allExecuteCalls.find(
        (c) => c[0].includes('ALTER') && c[0].includes('age')
      );
      expect(alterColCall).toBeDefined();
    });

    it('should return empty array when schema unchanged', async () => {
      const registry = createSchemaRegistry(driver);
      const schema = createValidSchema();

      // Mock existing schema
      (driver.query as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [
          {
            app_id: 'test-app',
            schema_name: 'test',
            version: '1.0.0',
            schema: JSON.stringify(schema),
            checksum: 'abc123',
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
        rowCount: 1,
      });

      const results = await registry.register({
        appId: 'test-app',
        schemaName: 'test',
        version: '1.0.0',
        schema,
      });

      expect(results).toEqual([]);
    });
  });

  describe('columnsEqual helper', () => {
    let driver: Driver;

    beforeEach(() => {
      driver = createMockDriver();
    });

    it('should consider columns equal when all properties match', async () => {
      const registry = createSchemaRegistry(driver);

      const schema1 = createValidSchema();
      schema1.tables.users.columns.status = {
        type: 'string',
        nullable: false,
        unique: true,
        default: "'active'",
      };

      (driver.query as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [
          {
            app_id: 'test-app',
            schema_name: 'test',
            version: '1.0.0',
            schema: JSON.stringify(schema1),
            checksum: 'abc123',
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
        rowCount: 1,
      });

      // Same schema
      const schema2 = createValidSchema();
      schema2.tables.users.columns.status = {
        type: 'string',
        nullable: false,
        unique: true,
        default: "'active'",
      };

      const results = await registry.register({
        appId: 'test-app',
        schemaName: 'test',
        version: '1.0.0',
        schema: schema2,
      });

      // No changes expected
      expect(results).toEqual([]);
    });

    it('should detect nullable change', async () => {
      const registry = createSchemaRegistry(driver);

      const schema1 = createValidSchema();
      schema1.tables.users.columns.bio = { type: 'text', nullable: false };

      (driver.query as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [
          {
            app_id: 'test-app',
            schema_name: 'test',
            version: '1.0.0',
            schema: JSON.stringify(schema1),
            checksum: 'abc123',
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
        rowCount: 1,
      });

      const schema2 = createValidSchema();
      schema2.tables.users.columns.bio = { type: 'text', nullable: true }; // Changed

      allExecuteCalls = [];

      await registry.register({
        appId: 'test-app',
        schemaName: 'test',
        version: '1.1.0',
        schema: schema2,
      });

      // Should detect change - look for ALTER with bio
      const alterCall = allExecuteCalls.find((c) => c[0].includes('bio'));
      expect(alterCall).toBeDefined();
    });

    it('should detect unique constraint change', async () => {
      const registry = createSchemaRegistry(driver);

      const schema1 = createValidSchema();
      schema1.tables.users.columns.username = { type: 'string', nullable: false, unique: false };

      (driver.query as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [
          {
            app_id: 'test-app',
            schema_name: 'test',
            version: '1.0.0',
            schema: JSON.stringify(schema1),
            checksum: 'abc123',
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
        rowCount: 1,
      });

      const schema2 = createValidSchema();
      schema2.tables.users.columns.username = { type: 'string', nullable: false, unique: true }; // Changed

      allExecuteCalls = [];

      await registry.register({
        appId: 'test-app',
        schemaName: 'test',
        version: '1.1.0',
        schema: schema2,
      });

      // Should detect change - look for ALTER with username
      const alterCall = allExecuteCalls.find((c) => c[0].includes('username'));
      expect(alterCall).toBeDefined();
    });
  });

  describe('ensureRegistryTable', () => {
    it('should create PostgreSQL-style registry table', async () => {
      const driver = createMockDriver('postgresql');
      const registry = createSchemaRegistry(driver);

      await registry.register({
        appId: 'test-app',
        schemaName: 'test',
        version: '1.0.0',
        schema: createValidSchema(),
      });

      const createTableCall = allExecuteCalls.find(
        (c) => c[0].includes('CREATE TABLE IF NOT EXISTS') && c[0].includes('lp_schema_registry')
      );
      expect(createTableCall).toBeDefined();
      expect(createTableCall![0]).toContain('JSONB');
      expect(createTableCall![0]).toContain('TIMESTAMPTZ');
    });

    it('should create MySQL-style registry table', async () => {
      const driver = createMockDriver('mysql');
      const registry = createSchemaRegistry(driver);

      await registry.register({
        appId: 'test-app',
        schemaName: 'test',
        version: '1.0.0',
        schema: createValidSchema(),
      });

      const createTableCall = allExecuteCalls.find(
        (c) => c[0].includes('CREATE TABLE IF NOT EXISTS') && c[0].includes('lp_schema_registry')
      );
      expect(createTableCall).toBeDefined();
      expect(createTableCall![0]).toContain('JSON');
      expect(createTableCall![0]).toContain('VARCHAR');
    });

    it('should create SQLite-style registry table', async () => {
      const driver = createMockDriver('sqlite');
      const registry = createSchemaRegistry(driver);

      await registry.register({
        appId: 'test-app',
        schemaName: 'test',
        version: '1.0.0',
        schema: createValidSchema(),
      });

      const createTableCall = allExecuteCalls.find(
        (c) => c[0].includes('CREATE TABLE IF NOT EXISTS') && c[0].includes('lp_schema_registry')
      );
      expect(createTableCall).toBeDefined();
      expect(createTableCall![0]).toContain('TEXT');
      expect(createTableCall![0]).toContain("datetime('now')");
    });

    it('should use custom table name', async () => {
      const driver = createMockDriver();
      const registry = createSchemaRegistry(driver, { tableName: 'custom_registry' });

      await registry.register({
        appId: 'test-app',
        schemaName: 'test',
        version: '1.0.0',
        schema: createValidSchema(),
      });

      const createTableCall = allExecuteCalls.find(
        (c) => c[0].includes('CREATE TABLE IF NOT EXISTS') && c[0].includes('custom_registry')
      );
      expect(createTableCall).toBeDefined();
    });
  });

  describe('getCurrentSchema', () => {
    it('should return null when schema not found', async () => {
      const driver = createMockDriver();
      const registry = createSchemaRegistry(driver);

      (driver.query as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [],
        rowCount: 0,
      });

      const result = await registry.getCurrentSchema('test-app', 'nonexistent');
      expect(result).toBeNull();
    });

    it('should parse JSON schema from PostgreSQL JSONB', async () => {
      const driver = createMockDriver();
      const registry = createSchemaRegistry(driver);
      const schema = createValidSchema();

      (driver.query as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [
          {
            app_id: 'test-app',
            schema_name: 'test',
            version: '1.0.0',
            schema: schema, // Already parsed (JSONB)
            checksum: 'abc123',
            created_at: new Date('2024-01-01'),
            updated_at: new Date('2024-01-01'),
          },
        ],
        rowCount: 1,
      });

      const result = await registry.getCurrentSchema('test-app', 'test');
      expect(result).not.toBeNull();
      expect(result?.schema).toEqual(schema);
    });

    it('should parse JSON schema from SQLite TEXT', async () => {
      const driver = createMockDriver('sqlite');
      const registry = createSchemaRegistry(driver);
      const schema = createValidSchema();

      (driver.query as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [
          {
            app_id: 'test-app',
            schema_name: 'test',
            version: '1.0.0',
            schema: JSON.stringify(schema), // Stored as string
            checksum: 'abc123',
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
          },
        ],
        rowCount: 1,
      });

      const result = await registry.getCurrentSchema('test-app', 'test');
      expect(result).not.toBeNull();
      expect(result?.schema).toEqual(schema);
    });
  });

  describe('listSchemas', () => {
    it('should list all schemas', async () => {
      const driver = createMockDriver();
      const registry = createSchemaRegistry(driver);
      const schema = createValidSchema();

      (driver.query as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [
          {
            app_id: 'app1',
            schema_name: 'users',
            version: '1.0.0',
            schema,
            checksum: 'abc123',
            created_at: new Date(),
            updated_at: new Date(),
          },
          {
            app_id: 'app2',
            schema_name: 'orders',
            version: '1.0.0',
            schema,
            checksum: 'def456',
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
        rowCount: 2,
      });

      const results = await registry.listSchemas();
      expect(results).toHaveLength(2);
    });

    it('should filter by appId', async () => {
      const driver = createMockDriver();
      const registry = createSchemaRegistry(driver);

      await registry.listSchemas('test-app');

      expect(driver.query).toHaveBeenCalledWith(expect.stringContaining('WHERE app_id = $1'), [
        'test-app',
      ]);
    });
  });

  describe('createSchemaRegistry factory', () => {
    it('should create SchemaRegistry instance', () => {
      const driver = createMockDriver();
      const registry = createSchemaRegistry(driver);
      expect(registry).toBeInstanceOf(SchemaRegistry);
    });

    it('should accept options', () => {
      const driver = createMockDriver();
      const registry = createSchemaRegistry(driver, { tableName: 'custom' });
      expect(registry).toBeInstanceOf(SchemaRegistry);
    });
  });
});
