import type { MongoOperation, QueryResult } from '../types/index.js';
import {
  type HealthCheckResult,
  type PoolStats,
  createHealthCheckResult,
  getDefaultHealthCheckConfig,
} from './health.js';
import { QueryTracker } from './query-tracker.js';
import type { Driver, DriverConfig, DrainOptions, DrainResult, TransactionClient } from './types.js';

let mongodbModule: typeof import('mongodb') | null = null;

async function getMongoDBModule(): Promise<typeof import('mongodb')> {
  if (!mongodbModule) {
    try {
      mongodbModule = await import('mongodb');
    } catch {
      throw new Error(
        'MongoDB driver not found. Please install mongodb package: npm install mongodb'
      );
    }
  }
  return mongodbModule;
}

export interface MongoDriverConfig extends DriverConfig {
  database?: string;
}

export interface MongoDriver extends Driver {
  executeOperation<T = Record<string, unknown>>(op: MongoOperation): Promise<QueryResult<T>>;
  getDb(): unknown;
  collection(name: string): unknown;
}

export async function createMongoDriver(config: MongoDriverConfig): Promise<MongoDriver> {
  const mongodb = await getMongoDBModule();
  const { MongoClient } = mongodb;

  const maxConnections = config.max ?? 10;

  const client = new MongoClient(config.connectionString, {
    maxPoolSize: maxConnections,
    serverSelectionTimeoutMS: config.connectTimeout ?? 5000,
    maxIdleTimeMS: config.idleTimeout ?? 30000,
  });

  await client.connect();
  const db = client.db(config.database);

  let lastHealthCheck: HealthCheckResult = createHealthCheckResult(true, 0);
  let healthCheckInterval: ReturnType<typeof setInterval> | null = null;

  const healthCheckConfig = getDefaultHealthCheckConfig(config.healthCheck);

  const tracker = new QueryTracker();
  let queryIdCounter = 0;
  let draining = false;

  const generateQueryId = () => `mongo-${++queryIdCounter}`;

  async function performHealthCheck(): Promise<HealthCheckResult> {
    const startTime = Date.now();
    try {
      await db.command({ ping: 1 });

      const result = createHealthCheckResult(true, Date.now() - startTime);

      if (!lastHealthCheck.healthy && healthCheckConfig.onHealthChange) {
        healthCheckConfig.onHealthChange(true, result);
      }

      lastHealthCheck = result;
      return result;
    } catch (error) {
      const result = createHealthCheckResult(
        false,
        Date.now() - startTime,
        error instanceof Error ? error.message : 'Unknown error'
      );

      if (lastHealthCheck.healthy && healthCheckConfig.onHealthChange) {
        healthCheckConfig.onHealthChange(false, result);
      }

      lastHealthCheck = result;
      return result;
    }
  }

  async function executeOperation<T = Record<string, unknown>>(
    op: MongoOperation
  ): Promise<QueryResult<T>> {
    const queryId = generateQueryId();
    tracker.trackQuery(queryId, `${op.type}:${op.collection}`);

    try {
      const collection = db.collection(op.collection);

      switch (op.type) {
        case 'find': {
          let cursor = collection.find(op.filter ?? {});
          if (op.options?.sort) cursor = cursor.sort(op.options.sort);
          if (op.options?.skip) cursor = cursor.skip(op.options.skip);
          if (op.options?.limit) cursor = cursor.limit(op.options.limit);
          if (op.options?.projection) cursor = cursor.project(op.options.projection);
          const rows = await cursor.toArray();
          return { rows: rows as T[], rowCount: rows.length };
        }

        case 'aggregate': {
          const result = await collection.aggregate(op.pipeline!).toArray();
          return { rows: result as T[], rowCount: result.length };
        }

        case 'insertOne': {
          const result = await collection.insertOne(op.document!);
          const doc = { ...op.document, _id: result.insertedId } as T;
          return { rows: [doc], rowCount: 1 };
        }

        case 'insertMany': {
          const result = await collection.insertMany(op.documents!);
          return { rows: op.documents as T[], rowCount: result.insertedCount };
        }

        case 'updateOne': {
          const result = await collection.updateOne(op.filter!, op.update!, {
            upsert: op.options?.upsert,
          });
          return { rows: [], rowCount: result.modifiedCount };
        }

        case 'updateMany': {
          const result = await collection.updateMany(op.filter!, op.update!, {
            upsert: op.options?.upsert,
          });
          return { rows: [], rowCount: result.modifiedCount };
        }

        case 'deleteOne': {
          const result = await collection.deleteOne(op.filter!);
          return { rows: [], rowCount: result.deletedCount };
        }

        case 'deleteMany': {
          const result = await collection.deleteMany(op.filter!);
          return { rows: [], rowCount: result.deletedCount };
        }

        case 'findOneAndUpdate': {
          const result = await collection.findOneAndUpdate(op.filter!, op.update!, {
            returnDocument: op.options?.returnDocument ?? 'after',
            upsert: op.options?.upsert,
            projection: op.options?.projection,
          });
          return { rows: result ? [result as T] : [], rowCount: result ? 1 : 0 };
        }

        case 'findOneAndDelete': {
          const result = await collection.findOneAndDelete(op.filter!, {
            projection: op.options?.projection,
          });
          return { rows: result ? [result as T] : [], rowCount: result ? 1 : 0 };
        }

        case 'countDocuments': {
          const count = await collection.countDocuments(op.filter ?? {});
          return { rows: [{ count } as T], rowCount: 1 };
        }

        default:
          throw new Error(`Unsupported MongoDB operation: ${(op as MongoOperation).type}`);
      }
    } finally {
      tracker.untrackQuery(queryId);
    }
  }

  async function executeOperationWithSession<T = Record<string, unknown>>(
    op: MongoOperation,
    session: import('mongodb').ClientSession
  ): Promise<QueryResult<T>> {
    const queryId = generateQueryId();
    tracker.trackQuery(queryId, `${op.type}:${op.collection}`);

    try {
      const collection = db.collection(op.collection);

      switch (op.type) {
        case 'find': {
          let cursor = collection.find(op.filter ?? {}, { session });
          if (op.options?.sort) cursor = cursor.sort(op.options.sort);
          if (op.options?.skip) cursor = cursor.skip(op.options.skip);
          if (op.options?.limit) cursor = cursor.limit(op.options.limit);
          if (op.options?.projection) cursor = cursor.project(op.options.projection);
          const rows = await cursor.toArray();
          return { rows: rows as T[], rowCount: rows.length };
        }

        case 'aggregate': {
          const result = await collection.aggregate(op.pipeline!, { session }).toArray();
          return { rows: result as T[], rowCount: result.length };
        }

        case 'insertOne': {
          const result = await collection.insertOne(op.document!, { session });
          const doc = { ...op.document, _id: result.insertedId } as T;
          return { rows: [doc], rowCount: 1 };
        }

        case 'insertMany': {
          const result = await collection.insertMany(op.documents!, { session });
          return { rows: op.documents as T[], rowCount: result.insertedCount };
        }

        case 'updateOne': {
          const result = await collection.updateOne(op.filter!, op.update!, {
            upsert: op.options?.upsert,
            session,
          });
          return { rows: [], rowCount: result.modifiedCount };
        }

        case 'updateMany': {
          const result = await collection.updateMany(op.filter!, op.update!, {
            upsert: op.options?.upsert,
            session,
          });
          return { rows: [], rowCount: result.modifiedCount };
        }

        case 'deleteOne': {
          const result = await collection.deleteOne(op.filter!, { session });
          return { rows: [], rowCount: result.deletedCount };
        }

        case 'deleteMany': {
          const result = await collection.deleteMany(op.filter!, { session });
          return { rows: [], rowCount: result.deletedCount };
        }

        case 'findOneAndUpdate': {
          const result = await collection.findOneAndUpdate(op.filter!, op.update!, {
            returnDocument: op.options?.returnDocument ?? 'after',
            upsert: op.options?.upsert,
            projection: op.options?.projection,
            session,
          });
          return { rows: result ? [result as T] : [], rowCount: result ? 1 : 0 };
        }

        case 'findOneAndDelete': {
          const result = await collection.findOneAndDelete(op.filter!, {
            projection: op.options?.projection,
            session,
          });
          return { rows: result ? [result as T] : [], rowCount: result ? 1 : 0 };
        }

        case 'countDocuments': {
          const count = await collection.countDocuments(op.filter ?? {}, { session });
          return { rows: [{ count } as T], rowCount: 1 };
        }

        default:
          throw new Error(`Unsupported MongoDB operation: ${(op as MongoOperation).type}`);
      }
    } finally {
      tracker.untrackQuery(queryId);
    }
  }

  const driver: MongoDriver = {
    dialect: 'mongodb',
    connectionString: config.connectionString,

    get isDraining() {
      return draining;
    },

    async query<T = Record<string, unknown>>(
      _sql: string,
      _params?: unknown[]
    ): Promise<QueryResult<T>> {
      throw new Error(
        'MongoDriver does not support SQL queries. Use executeOperation() with MongoOperation instead.'
      );
    },

    async execute(_sql: string, _params?: unknown[]): Promise<{ rowCount: number }> {
      throw new Error(
        'MongoDriver does not support SQL execution. Use executeOperation() with MongoOperation instead.'
      );
    },

    async transaction<T>(fn: (trx: MongoTransactionClient) => Promise<T>): Promise<T> {
      const txQueryId = generateQueryId();
      tracker.trackQuery(txQueryId, 'TRANSACTION');

      const session = client.startSession();
      try {
        session.startTransaction();
        const trxClient = new MongoTransactionClientImpl(session, executeOperationWithSession);
        const result = await fn(trxClient);
        await session.commitTransaction();
        return result;
      } catch (error) {
        await session.abortTransaction();
        throw error;
      } finally {
        await session.endSession();
        tracker.untrackQuery(txQueryId);
      }
    },

    getActiveQueryCount(): number {
      return tracker.getActiveCount();
    },

    async drainAndClose(options: DrainOptions = {}): Promise<DrainResult> {
      const startTime = Date.now();
      const timeout = options.timeout ?? 30000;

      draining = true;
      const initialActive = tracker.getActiveCount();

      options.onProgress?.({
        phase: 'draining',
        activeQueries: initialActive,
        completedQueries: 0,
        cancelledQueries: 0,
        elapsedMs: 0,
      });

      console.log(`[db-engine] Starting graceful shutdown with ${initialActive} active queries`);

      const { timedOut } = await tracker.startDrain(timeout);
      let cancelledQueries = 0;

      if (timedOut) {
        const activeQueries = tracker.getActiveQueries();
        console.log(`[db-engine] Timeout reached, ${activeQueries.length} queries still active`);
        cancelledQueries = activeQueries.length;

        options.onProgress?.({
          phase: 'cancelling',
          activeQueries: activeQueries.length,
          completedQueries: tracker.getStats().completed,
          cancelledQueries: 0,
          elapsedMs: Date.now() - startTime,
        });

        for (const query of activeQueries) {
          tracker.markCancelled(query.id);
        }
      }

      options.onProgress?.({
        phase: 'closing',
        activeQueries: 0,
        completedQueries: tracker.getStats().completed,
        cancelledQueries,
        elapsedMs: Date.now() - startTime,
      });

      console.log('[db-engine] Closing database connection');
      await client.close(true);

      const result: DrainResult = {
        success: true,
        completedQueries: tracker.getStats().completed,
        cancelledQueries,
        elapsedMs: Date.now() - startTime,
      };

      options.onProgress?.({
        phase: 'complete',
        activeQueries: 0,
        completedQueries: result.completedQueries,
        cancelledQueries: result.cancelledQueries,
        elapsedMs: result.elapsedMs,
      });

      console.log(`[db-engine] Shutdown complete in ${result.elapsedMs}ms`);
      return result;
    },

    async close(): Promise<void> {
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
      }
      await client.close();
    },

    async healthCheck(): Promise<HealthCheckResult> {
      return performHealthCheck();
    },

    getPoolStats(): PoolStats {
      return {
        totalConnections: maxConnections,
        activeConnections: 0,
        idleConnections: maxConnections,
        waitingRequests: 0,
        maxConnections,
      };
    },

    isHealthy(): boolean {
      return lastHealthCheck.healthy;
    },

    startHealthChecks(): void {
      if (healthCheckInterval) return;
      healthCheckInterval = setInterval(performHealthCheck, healthCheckConfig.intervalMs ?? 30000);
      performHealthCheck();
    },

    stopHealthChecks(): void {
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
      }
    },

    executeOperation,

    getDb() {
      return db;
    },

    collection(name: string) {
      return db.collection(name);
    },
  };

  return driver;
}

export interface MongoTransactionClient extends TransactionClient {
  executeOperation<T = Record<string, unknown>>(op: MongoOperation): Promise<QueryResult<T>>;
}

class MongoTransactionClientImpl implements MongoTransactionClient {
  constructor(
    private session: import('mongodb').ClientSession,
    private execWithSession: <T>(
      op: MongoOperation,
      session: import('mongodb').ClientSession
    ) => Promise<QueryResult<T>>
  ) {}

  async query<T = Record<string, unknown>>(
    _sql: string,
    _params?: unknown[]
  ): Promise<QueryResult<T>> {
    throw new Error('MongoTransactionClient does not support SQL queries.');
  }

  async execute(_sql: string, _params?: unknown[]): Promise<{ rowCount: number }> {
    throw new Error('MongoTransactionClient does not support SQL execution.');
  }

  async executeOperation<T = Record<string, unknown>>(op: MongoOperation): Promise<QueryResult<T>> {
    return this.execWithSession<T>(op, this.session);
  }
}

export function isMongoDriver(driver: Driver): driver is MongoDriver {
  return driver.dialect === 'mongodb' && 'executeOperation' in driver;
}
