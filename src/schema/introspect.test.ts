import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Driver } from '../driver/types.js';
import type { Dialect } from '../migrations/dialects/types.js';
import { SchemaIntrospector } from './introspect.js';

const createMockDriver = (): Driver => ({
  dialect: 'postgresql',
  connectionString: 'postgresql://test',
  query: vi.fn(),
  execute: vi.fn(),
  transaction: vi.fn(),
  close: vi.fn(),
});

const createMockDialect = (): Dialect => ({
  name: 'postgresql',
  supportsTransactionalDDL: true,
  mapType: vi.fn((type) => type.toUpperCase()),
  createTable: vi.fn(),
  dropTable: vi.fn(),
  addColumn: vi.fn(),
  dropColumn: vi.fn(),
  alterColumn: vi.fn(),
  createIndex: vi.fn(),
  dropIndex: vi.fn(),
  addForeignKey: vi.fn(),
  dropForeignKey: vi.fn(),
  introspectTablesQuery: vi.fn(() => 'SELECT table_name FROM information_schema.tables'),
  introspectColumnsQuery: vi.fn((table) => `SELECT * FROM columns WHERE table = '${table}'`),
  introspectIndexesQuery: vi.fn((table) => `SELECT * FROM indexes WHERE table = '${table}'`),
});

describe('SchemaIntrospector', () => {
  let driver: Driver;
  let dialect: Dialect;
  let introspector: SchemaIntrospector;

  beforeEach(() => {
    driver = createMockDriver();
    dialect = createMockDialect();
    introspector = new SchemaIntrospector(driver, dialect);
  });

  describe('listTables', () => {
    it('should list tables excluding system tables', async () => {
      vi.mocked(driver.query).mockResolvedValueOnce({
        rows: [
          { table_name: 'users' },
          { table_name: 'orders' },
          { table_name: 'lp_migrations' },
          { table_name: 'pg_settings' },
        ],
        rowCount: 4,
      });

      const tables = await introspector.listTables();

      expect(tables).toEqual(['users', 'orders']);
      expect(tables).not.toContain('lp_migrations');
      expect(tables).not.toContain('pg_settings');
    });

    it('should include launchpad tables when option is set', async () => {
      vi.mocked(driver.query).mockResolvedValueOnce({
        rows: [{ table_name: 'users' }, { table_name: 'lp_migrations' }],
        rowCount: 2,
      });

      const tables = await introspector.listTables({ includeLaunchpadTables: true });

      expect(tables).toContain('users');
      expect(tables).toContain('lp_migrations');
    });

    it('should exclude specified tables', async () => {
      vi.mocked(driver.query).mockResolvedValueOnce({
        rows: [{ table_name: 'users' }, { table_name: 'temp_data' }, { table_name: 'orders' }],
        rowCount: 3,
      });

      const tables = await introspector.listTables({ excludeTables: ['temp_data'] });

      expect(tables).toEqual(['users', 'orders']);
    });
  });

  describe('introspectColumns', () => {
    it('should introspect PostgreSQL columns', async () => {
      vi.mocked(driver.query).mockResolvedValueOnce({
        rows: [
          {
            column_name: 'id',
            data_type: 'uuid',
            udt_name: 'uuid',
            is_nullable: 'NO',
            column_default: 'gen_random_uuid()',
            character_maximum_length: null,
            numeric_precision: null,
            numeric_scale: null,
            is_identity: 'NO',
            identity_generation: null,
          },
          {
            column_name: 'email',
            data_type: 'character varying',
            udt_name: 'varchar',
            is_nullable: 'NO',
            column_default: null,
            character_maximum_length: 255,
            numeric_precision: null,
            numeric_scale: null,
            is_identity: 'NO',
            identity_generation: null,
          },
        ],
        rowCount: 2,
      });

      const columns = await introspector.introspectColumns('users');

      expect(columns).toHaveLength(2);
      expect(columns[0]).toEqual({
        name: 'id',
        dataType: 'uuid',
        udtName: 'uuid',
        isNullable: false,
        defaultValue: 'gen_random_uuid()',
        maxLength: null,
        numericPrecision: null,
        numericScale: null,
        isIdentity: false,
        identityGeneration: null,
      });
    });
  });

  describe('introspectIndexes', () => {
    it('should introspect PostgreSQL indexes', async () => {
      vi.mocked(driver.query).mockResolvedValueOnce({
        rows: [
          {
            index_name: 'users_pkey',
            columns: ['id'],
            is_unique: true,
            is_primary: true,
            index_type: 'btree',
            expression: null,
          },
          {
            index_name: 'idx_users_email',
            columns: ['email'],
            is_unique: true,
            is_primary: false,
            index_type: 'btree',
            expression: null,
          },
        ],
        rowCount: 2,
      });

      const indexes = await introspector.introspectIndexes('users');

      expect(indexes).toHaveLength(2);
      expect(indexes[0]).toEqual({
        name: 'users_pkey',
        columns: ['id'],
        isUnique: true,
        isPrimary: true,
        type: 'btree',
        expression: null,
      });
    });
  });

  describe('introspectForeignKeys', () => {
    it('should introspect PostgreSQL foreign keys', async () => {
      vi.mocked(driver.query).mockResolvedValueOnce({
        rows: [
          {
            constraint_name: 'fk_orders_user_id',
            columns: ['user_id'],
            referenced_table: 'users',
            referenced_columns: ['id'],
            on_delete: 'CASCADE',
            on_update: 'NO ACTION',
          },
        ],
        rowCount: 1,
      });

      const foreignKeys = await introspector.introspectForeignKeys('orders');

      expect(foreignKeys).toHaveLength(1);
      expect(foreignKeys[0]).toEqual({
        name: 'fk_orders_user_id',
        columns: ['user_id'],
        referencedTable: 'users',
        referencedColumns: ['id'],
        onDelete: 'CASCADE',
        onUpdate: 'NO ACTION',
      });
    });
  });

  describe('toSchemaDefinition', () => {
    it('should convert introspection result to SchemaDefinition', () => {
      const result = {
        tables: [
          {
            name: 'users',
            schema: 'public',
            columns: [
              {
                name: 'id',
                dataType: 'uuid',
                udtName: 'uuid',
                isNullable: false,
                defaultValue: 'gen_random_uuid()',
                maxLength: null,
                numericPrecision: null,
                numericScale: null,
                isIdentity: false,
                identityGeneration: null,
              },
              {
                name: 'app_id',
                dataType: 'text',
                udtName: 'text',
                isNullable: false,
                defaultValue: null,
                maxLength: null,
                numericPrecision: null,
                numericScale: null,
                isIdentity: false,
                identityGeneration: null,
              },
            ],
            primaryKey: ['id'],
            foreignKeys: [],
            indexes: [],
            constraints: [],
          },
        ],
        enums: [],
        extensions: [],
        introspectedAt: new Date(),
        databaseVersion: 'PostgreSQL 16.0',
      };

      const schema = introspector.toSchemaDefinition(result);

      expect(schema.tables).toHaveProperty('users');
      expect(schema.tables.users.columns).toHaveProperty('id');
      expect(schema.tables.users.columns.id.type).toBe('uuid');
      expect(schema.tables.users.columns.id.primaryKey).toBe(true);
      expect(schema.tables.users.columns.app_id.tenant).toBe(true);
    });
  });

  describe('getDatabaseVersion', () => {
    it('should get PostgreSQL version', async () => {
      vi.mocked(driver.query).mockResolvedValueOnce({
        rows: [{ version: 'PostgreSQL 16.0 on x86_64-pc-linux-gnu' }],
        rowCount: 1,
      });

      const version = await introspector.getDatabaseVersion();

      expect(version).toBe('PostgreSQL 16.0 on x86_64-pc-linux-gnu');
    });
  });
});
