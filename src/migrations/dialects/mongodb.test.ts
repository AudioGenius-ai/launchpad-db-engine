import { describe, expect, it, vi } from 'vitest';
import type { ColumnDefinition, IndexDefinition, TableDefinition } from '../../types/index.js';
import { type MongoMigrationOperation, executeMongoMigration, mongoDialect } from './mongodb.js';

describe('mongoDialect', () => {
  describe('name', () => {
    it('should return mongodb', () => {
      expect(mongoDialect.name).toBe('mongodb');
    });
  });

  describe('supportsTransactionalDDL', () => {
    it('should return true', () => {
      expect(mongoDialect.supportsTransactionalDDL).toBe(true);
    });
  });

  describe('mapType', () => {
    it('should map uuid to string', () => {
      expect(mongoDialect.mapType('uuid')).toBe('string');
    });

    it('should map string to string', () => {
      expect(mongoDialect.mapType('string')).toBe('string');
    });

    it('should map text to string', () => {
      expect(mongoDialect.mapType('text')).toBe('string');
    });

    it('should map integer to int', () => {
      expect(mongoDialect.mapType('integer')).toBe('int');
    });

    it('should map bigint to long', () => {
      expect(mongoDialect.mapType('bigint')).toBe('long');
    });

    it('should map float to double', () => {
      expect(mongoDialect.mapType('float')).toBe('double');
    });

    it('should map decimal to decimal', () => {
      expect(mongoDialect.mapType('decimal')).toBe('decimal');
    });

    it('should map boolean to bool', () => {
      expect(mongoDialect.mapType('boolean')).toBe('bool');
    });

    it('should map datetime to date', () => {
      expect(mongoDialect.mapType('datetime')).toBe('date');
    });

    it('should map date to date', () => {
      expect(mongoDialect.mapType('date')).toBe('date');
    });

    it('should map time to string', () => {
      expect(mongoDialect.mapType('time')).toBe('string');
    });

    it('should map json to object', () => {
      expect(mongoDialect.mapType('json')).toBe('object');
    });

    it('should map binary to binData', () => {
      expect(mongoDialect.mapType('binary')).toBe('binData');
    });
  });

  describe('createTable', () => {
    it('should generate createCollection operation', () => {
      const def: TableDefinition = {
        columns: {
          id: { type: 'uuid', nullable: false },
          email: { type: 'string', nullable: false },
          name: { type: 'string', nullable: true },
        },
      };
      const op = mongoDialect.createTable('users', def);

      expect(op.operation).toBe('createCollection');
      expect(op.collection).toBe('users');
      expect(op.options?.validator?.$jsonSchema).toBeDefined();
      expect(op.options?.validator?.$jsonSchema.properties).toHaveProperty('id');
      expect(op.options?.validator?.$jsonSchema.properties).toHaveProperty('email');
      expect(op.options?.validator?.$jsonSchema.properties).toHaveProperty('name');
    });

    it('should mark non-nullable columns without defaults as required', () => {
      const def: TableDefinition = {
        columns: {
          id: { type: 'uuid', nullable: false },
          email: { type: 'string', nullable: false },
          status: { type: 'string', nullable: false, default: 'active' },
          name: { type: 'string', nullable: true },
        },
      };
      const op = mongoDialect.createTable('users', def);

      const required = op.options?.validator?.$jsonSchema.required;
      expect(required).toContain('id');
      expect(required).toContain('email');
      expect(required).not.toContain('status');
      expect(required).not.toContain('name');
    });

    it('should handle nullable columns with bsonType array', () => {
      const def: TableDefinition = {
        columns: {
          name: { type: 'string', nullable: true },
        },
      };
      const op = mongoDialect.createTable('users', def);

      const nameSchema = op.options?.validator?.$jsonSchema.properties?.name;
      expect(nameSchema?.bsonType).toEqual(['string', 'null']);
    });

    it('should map column types to BSON types', () => {
      const def: TableDefinition = {
        columns: {
          id: { type: 'uuid', nullable: false },
          count: { type: 'integer', nullable: false },
          amount: { type: 'decimal', nullable: false },
          active: { type: 'boolean', nullable: false },
          created: { type: 'datetime', nullable: false },
          data: { type: 'json', nullable: false },
        },
      };
      const op = mongoDialect.createTable('test', def);

      const props = op.options?.validator?.$jsonSchema.properties;
      expect(props?.id?.bsonType).toBe('string');
      expect(props?.count?.bsonType).toBe('int');
      expect(props?.amount?.bsonType).toBe('decimal');
      expect(props?.active?.bsonType).toBe('bool');
      expect(props?.created?.bsonType).toBe('date');
      expect(props?.data?.bsonType).toBe('object');
    });
  });

  describe('dropTable', () => {
    it('should generate dropCollection operation', () => {
      const op = mongoDialect.dropTable('users');

      expect(op.operation).toBe('dropCollection');
      expect(op.collection).toBe('users');
    });
  });

  describe('addColumn', () => {
    it('should generate collMod operation with addProperty action', () => {
      const def: ColumnDefinition = { type: 'string', nullable: false };
      const op = mongoDialect.addColumn('users', 'phone', def);

      expect(op.operation).toBe('collMod');
      expect(op.collection).toBe('users');
      expect(op.options?.validatorAction).toBe('addProperty');
      expect(op.options?.property).toBe('phone');
      expect(op.options?.schema?.bsonType).toBe('string');
    });

    it('should mark column as required when not nullable and no default', () => {
      const def: ColumnDefinition = { type: 'string', nullable: false };
      const op = mongoDialect.addColumn('users', 'email', def);

      expect(op.options?.required).toBe(true);
    });

    it('should not mark column as required when nullable', () => {
      const def: ColumnDefinition = { type: 'string', nullable: true };
      const op = mongoDialect.addColumn('users', 'email', def);

      expect(op.options?.required).toBe(false);
    });

    it('should not mark column as required when has default', () => {
      const def: ColumnDefinition = { type: 'string', nullable: false, default: 'test' };
      const op = mongoDialect.addColumn('users', 'status', def);

      expect(op.options?.required).toBe(false);
    });

    it('should handle nullable columns with bsonType array', () => {
      const def: ColumnDefinition = { type: 'integer', nullable: true };
      const op = mongoDialect.addColumn('users', 'age', def);

      expect(op.options?.schema?.bsonType).toEqual(['int', 'null']);
    });
  });

  describe('dropColumn', () => {
    it('should generate collMod operation with removeProperty action', () => {
      const op = mongoDialect.dropColumn('users', 'phone');

      expect(op.operation).toBe('collMod');
      expect(op.collection).toBe('users');
      expect(op.options?.validatorAction).toBe('removeProperty');
      expect(op.options?.property).toBe('phone');
    });
  });

  describe('alterColumn', () => {
    it('should generate collMod operation with modifyProperty action', () => {
      const def: ColumnDefinition = { type: 'text', nullable: false };
      const op = mongoDialect.alterColumn('users', 'name', def);

      expect(op.operation).toBe('collMod');
      expect(op.collection).toBe('users');
      expect(op.options?.validatorAction).toBe('modifyProperty');
      expect(op.options?.property).toBe('name');
      expect(op.options?.schema?.bsonType).toBe('string');
    });

    it('should handle nullable change', () => {
      const def: ColumnDefinition = { type: 'string', nullable: true };
      const op = mongoDialect.alterColumn('users', 'email', def);

      expect(op.options?.schema?.bsonType).toEqual(['string', 'null']);
    });
  });

  describe('createIndex', () => {
    it('should generate createIndex operation', () => {
      const index: IndexDefinition = { columns: ['email'] };
      const op = mongoDialect.createIndex('users', index);

      expect(op.operation).toBe('createIndex');
      expect(op.collection).toBe('users');
      expect(op.indexSpec?.keys).toEqual({ email: 1 });
    });

    it('should handle composite indexes', () => {
      const index: IndexDefinition = { columns: ['user_id', 'created_at'] };
      const op = mongoDialect.createIndex('orders', index);

      expect(op.indexSpec?.keys).toEqual({ user_id: 1, created_at: 1 });
    });

    it('should generate default index name when not provided', () => {
      const index: IndexDefinition = { columns: ['email'] };
      const op = mongoDialect.createIndex('users', index);

      expect(op.indexSpec?.options?.name).toBe('idx_users_email');
    });

    it('should use provided index name', () => {
      const index: IndexDefinition = { columns: ['email'], name: 'my_custom_index' };
      const op = mongoDialect.createIndex('users', index);

      expect(op.indexSpec?.options?.name).toBe('my_custom_index');
    });

    it('should handle unique indexes', () => {
      const index: IndexDefinition = { columns: ['email'], unique: true };
      const op = mongoDialect.createIndex('users', index);

      expect(op.indexSpec?.options?.unique).toBe(true);
    });

    it('should default unique to false', () => {
      const index: IndexDefinition = { columns: ['email'] };
      const op = mongoDialect.createIndex('users', index);

      expect(op.indexSpec?.options?.unique).toBe(false);
    });
  });

  describe('dropIndex', () => {
    it('should generate dropIndex operation', () => {
      const op = mongoDialect.dropIndex('idx_users_email', 'users');

      expect(op.operation).toBe('dropIndex');
      expect(op.collection).toBe('users');
      expect(op.options?.indexName).toBe('idx_users_email');
    });
  });
});

describe('executeMongoMigration', () => {
  it('should execute createCollection operation', async () => {
    const mockDb = {
      createCollection: vi.fn().mockResolvedValue(undefined),
    };

    const op: MongoMigrationOperation = {
      operation: 'createCollection',
      collection: 'users',
      options: { validator: { $jsonSchema: {} } },
    };

    await executeMongoMigration(mockDb, op);

    expect(mockDb.createCollection).toHaveBeenCalledWith('users', op.options);
  });

  it('should execute dropCollection operation', async () => {
    const mockDb = {
      dropCollection: vi.fn().mockResolvedValue(undefined),
    };

    const op: MongoMigrationOperation = {
      operation: 'dropCollection',
      collection: 'users',
    };

    await executeMongoMigration(mockDb, op);

    expect(mockDb.dropCollection).toHaveBeenCalledWith('users');
  });

  it('should execute createIndex operation', async () => {
    const mockCollection = {
      createIndex: vi.fn().mockResolvedValue('idx_users_email'),
    };
    const mockDb = {
      collection: vi.fn().mockReturnValue(mockCollection),
    };

    const op: MongoMigrationOperation = {
      operation: 'createIndex',
      collection: 'users',
      indexSpec: {
        keys: { email: 1 },
        options: { name: 'idx_users_email', unique: true },
      },
    };

    await executeMongoMigration(mockDb, op);

    expect(mockDb.collection).toHaveBeenCalledWith('users');
    expect(mockCollection.createIndex).toHaveBeenCalledWith(
      { email: 1 },
      { name: 'idx_users_email', unique: true }
    );
  });

  it('should throw error when indexSpec missing for createIndex', async () => {
    const mockDb = {};

    const op: MongoMigrationOperation = {
      operation: 'createIndex',
      collection: 'users',
    };

    await expect(executeMongoMigration(mockDb, op)).rejects.toThrow(
      'Index specification required for createIndex operation'
    );
  });

  it('should execute dropIndex operation', async () => {
    const mockCollection = {
      dropIndex: vi.fn().mockResolvedValue(undefined),
    };
    const mockDb = {
      collection: vi.fn().mockReturnValue(mockCollection),
    };

    const op: MongoMigrationOperation = {
      operation: 'dropIndex',
      collection: 'users',
      options: { indexName: 'idx_users_email' },
    };

    await executeMongoMigration(mockDb, op);

    expect(mockDb.collection).toHaveBeenCalledWith('users');
    expect(mockCollection.dropIndex).toHaveBeenCalledWith('idx_users_email');
  });

  it('should execute collMod addProperty operation', async () => {
    const mockCollection = {};
    const mockDb = {
      collection: vi.fn().mockReturnValue(mockCollection),
      listCollections: vi.fn().mockReturnValue({
        toArray: vi.fn().mockResolvedValue([
          {
            name: 'users',
            options: {
              validator: {
                $jsonSchema: {
                  bsonType: 'object',
                  properties: { id: { bsonType: 'string' } },
                  required: ['id'],
                },
              },
            },
          },
        ]),
      }),
      command: vi.fn().mockResolvedValue(undefined),
    };

    const op: MongoMigrationOperation = {
      operation: 'collMod',
      collection: 'users',
      options: {
        validatorAction: 'addProperty',
        property: 'email',
        schema: { bsonType: 'string' },
        required: true,
      },
    };

    await executeMongoMigration(mockDb, op);

    expect(mockDb.command).toHaveBeenCalledWith(
      expect.objectContaining({
        collMod: 'users',
        validator: expect.objectContaining({
          $jsonSchema: expect.objectContaining({
            properties: expect.objectContaining({
              id: { bsonType: 'string' },
              email: { bsonType: 'string' },
            }),
            required: expect.arrayContaining(['id', 'email']),
          }),
        }),
      })
    );
  });

  it('should execute collMod removeProperty operation', async () => {
    const mockDb = {
      collection: vi.fn().mockReturnValue({}),
      listCollections: vi.fn().mockReturnValue({
        toArray: vi.fn().mockResolvedValue([
          {
            name: 'users',
            options: {
              validator: {
                $jsonSchema: {
                  bsonType: 'object',
                  properties: { id: { bsonType: 'string' }, email: { bsonType: 'string' } },
                  required: ['id', 'email'],
                },
              },
            },
          },
        ]),
      }),
      command: vi.fn().mockResolvedValue(undefined),
    };

    const op: MongoMigrationOperation = {
      operation: 'collMod',
      collection: 'users',
      options: {
        validatorAction: 'removeProperty',
        property: 'email',
      },
    };

    await executeMongoMigration(mockDb, op);

    expect(mockDb.command).toHaveBeenCalledWith(
      expect.objectContaining({
        collMod: 'users',
        validator: expect.objectContaining({
          $jsonSchema: expect.objectContaining({
            properties: expect.not.objectContaining({
              email: expect.anything(),
            }),
            required: expect.not.arrayContaining(['email']),
          }),
        }),
      })
    );
  });

  it('should throw error for non-existent collection on collMod', async () => {
    const mockDb = {
      collection: vi.fn().mockReturnValue({}),
      listCollections: vi.fn().mockReturnValue({
        toArray: vi.fn().mockResolvedValue([]),
      }),
    };

    const op: MongoMigrationOperation = {
      operation: 'collMod',
      collection: 'nonexistent',
      options: {
        validatorAction: 'addProperty',
        property: 'email',
        schema: { bsonType: 'string' },
      },
    };

    await expect(executeMongoMigration(mockDb, op)).rejects.toThrow(
      'Collection nonexistent does not exist'
    );
  });

  it('should throw error for unsupported operation', async () => {
    const mockDb = {};

    const op = {
      operation: 'unsupported' as MongoMigrationOperation['operation'],
      collection: 'users',
    };

    await expect(executeMongoMigration(mockDb, op as MongoMigrationOperation)).rejects.toThrow(
      'Unsupported MongoDB migration operation'
    );
  });
});
