import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MongoOperation } from '../types/index.js';

vi.mock('mongodb', async () => {
  const mockCollection = {
    find: vi.fn().mockReturnThis(),
    sort: vi.fn().mockReturnThis(),
    skip: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    project: vi.fn().mockReturnThis(),
    toArray: vi.fn().mockResolvedValue([{ id: '1', name: 'Test' }]),
    aggregate: vi.fn().mockReturnThis(),
    insertOne: vi.fn().mockResolvedValue({ insertedId: 'new-id' }),
    insertMany: vi.fn().mockResolvedValue({ insertedCount: 2 }),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    updateMany: vi.fn().mockResolvedValue({ modifiedCount: 5 }),
    deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
    deleteMany: vi.fn().mockResolvedValue({ deletedCount: 3 }),
    findOneAndUpdate: vi.fn().mockResolvedValue({ id: '1', status: 'updated' }),
    findOneAndDelete: vi.fn().mockResolvedValue({ id: '1', name: 'deleted' }),
    countDocuments: vi.fn().mockResolvedValue(42),
  };

  const mockDb = {
    collection: vi.fn().mockReturnValue(mockCollection),
  };

  const mockSession = {
    startTransaction: vi.fn(),
    commitTransaction: vi.fn().mockResolvedValue(undefined),
    abortTransaction: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined),
  };

  const mockClient = {
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    db: vi.fn().mockReturnValue(mockDb),
    startSession: vi.fn().mockReturnValue(mockSession),
  };

  return {
    MongoClient: vi.fn().mockImplementation(() => mockClient),
  };
});

import { type MongoDriver, createMongoDriver, isMongoDriver } from './mongodb.js';
import type { Driver } from './types.js';

describe('MongoDriver', () => {
  let driver: MongoDriver;

  beforeAll(async () => {
    driver = await createMongoDriver({
      connectionString: 'mongodb://localhost:27017',
      database: 'test_db',
    });
  });

  afterAll(async () => {
    await driver.close();
  });

  describe('createMongoDriver', () => {
    it('should create a driver with mongodb dialect', () => {
      expect(driver.dialect).toBe('mongodb');
    });

    it('should store the connection string', () => {
      expect(driver.connectionString).toBe('mongodb://localhost:27017');
    });

    it('should expose getDb method', () => {
      expect(typeof driver.getDb).toBe('function');
      expect(driver.getDb()).toBeDefined();
    });

    it('should expose collection method', () => {
      expect(typeof driver.collection).toBe('function');
      expect(driver.collection('users')).toBeDefined();
    });
  });

  describe('query (SQL)', () => {
    it('should throw error for SQL queries', async () => {
      await expect(driver.query('SELECT * FROM users')).rejects.toThrow(
        'MongoDriver does not support SQL queries'
      );
    });
  });

  describe('execute (SQL)', () => {
    it('should throw error for SQL execution', async () => {
      await expect(driver.execute('DELETE FROM users')).rejects.toThrow(
        'MongoDriver does not support SQL execution'
      );
    });
  });

  describe('executeOperation - find', () => {
    it('should execute find operation', async () => {
      const op: MongoOperation = {
        type: 'find',
        collection: 'users',
        filter: { status: 'active' },
      };

      const result = await driver.executeOperation(op);

      expect(result.rows).toHaveLength(1);
      expect(result.rowCount).toBe(1);
    });

    it('should execute find with options', async () => {
      const op: MongoOperation = {
        type: 'find',
        collection: 'users',
        filter: {},
        options: {
          sort: { name: 1 },
          skip: 10,
          limit: 5,
          projection: { id: 1, name: 1 },
        },
      };

      const result = await driver.executeOperation(op);

      expect(result.rows).toBeDefined();
    });
  });

  describe('executeOperation - aggregate', () => {
    it('should execute aggregate operation', async () => {
      const op: MongoOperation = {
        type: 'aggregate',
        collection: 'orders',
        pipeline: [
          { $match: { status: 'completed' } },
          { $group: { _id: '$userId', total: { $sum: '$amount' } } },
        ],
      };

      const result = await driver.executeOperation(op);

      expect(result.rows).toBeDefined();
    });
  });

  describe('executeOperation - insertOne', () => {
    it('should execute insertOne operation', async () => {
      const op: MongoOperation = {
        type: 'insertOne',
        collection: 'users',
        document: { name: 'John', email: 'john@example.com' },
      };

      const result = await driver.executeOperation(op);

      expect(result.rowCount).toBe(1);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toHaveProperty('_id');
    });
  });

  describe('executeOperation - insertMany', () => {
    it('should execute insertMany operation', async () => {
      const op: MongoOperation = {
        type: 'insertMany',
        collection: 'users',
        documents: [
          { name: 'John', email: 'john@example.com' },
          { name: 'Jane', email: 'jane@example.com' },
        ],
      };

      const result = await driver.executeOperation(op);

      expect(result.rowCount).toBe(2);
    });
  });

  describe('executeOperation - updateOne', () => {
    it('should execute updateOne operation', async () => {
      const op: MongoOperation = {
        type: 'updateOne',
        collection: 'users',
        filter: { id: '123' },
        update: { $set: { status: 'active' } },
      };

      const result = await driver.executeOperation(op);

      expect(result.rowCount).toBe(1);
      expect(result.rows).toHaveLength(0);
    });
  });

  describe('executeOperation - updateMany', () => {
    it('should execute updateMany operation', async () => {
      const op: MongoOperation = {
        type: 'updateMany',
        collection: 'users',
        filter: { status: 'pending' },
        update: { $set: { status: 'active' } },
      };

      const result = await driver.executeOperation(op);

      expect(result.rowCount).toBe(5);
    });
  });

  describe('executeOperation - deleteOne', () => {
    it('should execute deleteOne operation', async () => {
      const op: MongoOperation = {
        type: 'deleteOne',
        collection: 'users',
        filter: { id: '123' },
      };

      const result = await driver.executeOperation(op);

      expect(result.rowCount).toBe(1);
    });
  });

  describe('executeOperation - deleteMany', () => {
    it('should execute deleteMany operation', async () => {
      const op: MongoOperation = {
        type: 'deleteMany',
        collection: 'users',
        filter: { status: 'deleted' },
      };

      const result = await driver.executeOperation(op);

      expect(result.rowCount).toBe(3);
    });
  });

  describe('executeOperation - findOneAndUpdate', () => {
    it('should execute findOneAndUpdate operation', async () => {
      const op: MongoOperation = {
        type: 'findOneAndUpdate',
        collection: 'users',
        filter: { id: '123' },
        update: { $set: { status: 'updated' } },
        options: {
          returnDocument: 'after',
          projection: { id: 1, status: 1 },
        },
      };

      const result = await driver.executeOperation(op);

      expect(result.rowCount).toBe(1);
      expect(result.rows).toHaveLength(1);
    });
  });

  describe('executeOperation - findOneAndDelete', () => {
    it('should execute findOneAndDelete operation', async () => {
      const op: MongoOperation = {
        type: 'findOneAndDelete',
        collection: 'users',
        filter: { id: '123' },
        options: {
          projection: { id: 1, name: 1 },
        },
      };

      const result = await driver.executeOperation(op);

      expect(result.rowCount).toBe(1);
      expect(result.rows).toHaveLength(1);
    });
  });

  describe('executeOperation - countDocuments', () => {
    it('should execute countDocuments operation', async () => {
      const op: MongoOperation = {
        type: 'countDocuments',
        collection: 'users',
        filter: { status: 'active' },
      };

      const result = await driver.executeOperation(op);

      expect(result.rowCount).toBe(1);
      expect(result.rows[0]).toEqual({ count: 42 });
    });
  });

  describe('executeOperation - unsupported', () => {
    it('should throw error for unsupported operation type', async () => {
      const op = {
        type: 'unsupported' as MongoOperation['type'],
        collection: 'users',
      };

      await expect(driver.executeOperation(op)).rejects.toThrow('Unsupported MongoDB operation');
    });
  });

  describe('transaction', () => {
    it('should execute operations within a transaction', async () => {
      const result = await driver.transaction(async (trx) => {
        const op: MongoOperation = {
          type: 'insertOne',
          collection: 'users',
          document: { name: 'Test' },
        };
        const insertResult = await trx.executeOperation(op);
        return insertResult.rows[0];
      });

      expect(result).toBeDefined();
    });

    it('should abort transaction on error', async () => {
      await expect(
        driver.transaction(async () => {
          throw new Error('Transaction error');
        })
      ).rejects.toThrow('Transaction error');
    });

    it('should throw error for SQL in transaction', async () => {
      await expect(
        driver.transaction(async (trx) => {
          await trx.query('SELECT * FROM users');
        })
      ).rejects.toThrow('does not support SQL queries');
    });

    it('should throw error for SQL execute in transaction', async () => {
      await expect(
        driver.transaction(async (trx) => {
          await trx.execute('DELETE FROM users');
        })
      ).rejects.toThrow('does not support SQL execution');
    });
  });
});

describe('isMongoDriver', () => {
  it('should return true for MongoDriver', async () => {
    const driver = await createMongoDriver({
      connectionString: 'mongodb://localhost:27017',
      database: 'test',
    });

    expect(isMongoDriver(driver)).toBe(true);
    await driver.close();
  });

  it('should return false for non-MongoDriver', () => {
    const fakeDriver: Driver = {
      dialect: 'postgresql',
      connectionString: 'postgresql://localhost:5432/test',
      query: vi.fn(),
      execute: vi.fn(),
      transaction: vi.fn(),
      close: vi.fn(),
    };

    expect(isMongoDriver(fakeDriver)).toBe(false);
  });
});
