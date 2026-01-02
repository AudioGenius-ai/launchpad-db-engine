var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/driver/health.ts
function createHealthCheckResult(healthy, latencyMs, error) {
  return {
    healthy,
    latencyMs,
    lastCheckedAt: /* @__PURE__ */ new Date(),
    ...error && { error }
  };
}
function getDefaultHealthCheckConfig(overrides) {
  return {
    enabled: overrides?.enabled ?? false,
    intervalMs: overrides?.intervalMs ?? 3e4,
    timeoutMs: overrides?.timeoutMs ?? 5e3,
    onHealthChange: overrides?.onHealthChange
  };
}
var init_health = __esm({
  "src/driver/health.ts"() {
    "use strict";
  }
});

// src/driver/query-tracker.ts
var QueryTracker;
var init_query_tracker = __esm({
  "src/driver/query-tracker.ts"() {
    "use strict";
    QueryTracker = class {
      activeQueries = /* @__PURE__ */ new Map();
      completedCount = 0;
      cancelledCount = 0;
      draining = false;
      drainResolve = null;
      trackQuery(id, query, backendPid) {
        if (this.draining) {
          throw new Error("Driver is draining - new queries are not accepted");
        }
        this.activeQueries.set(id, {
          id,
          query: query.slice(0, 200),
          startedAt: /* @__PURE__ */ new Date(),
          backendPid
        });
      }
      untrackQuery(id) {
        if (this.activeQueries.delete(id)) {
          this.completedCount++;
          if (this.draining && this.activeQueries.size === 0 && this.drainResolve) {
            this.drainResolve();
          }
        }
      }
      getActiveCount() {
        return this.activeQueries.size;
      }
      getActiveQueries() {
        return Array.from(this.activeQueries.values());
      }
      async startDrain(timeoutMs) {
        this.draining = true;
        if (this.activeQueries.size === 0) {
          return { timedOut: false };
        }
        const drainPromise = new Promise((resolve) => {
          this.drainResolve = resolve;
        });
        const timeoutPromise = new Promise((resolve) => {
          setTimeout(() => resolve("timeout"), timeoutMs);
        });
        const result = await Promise.race([
          drainPromise.then(() => "drained"),
          timeoutPromise
        ]);
        return { timedOut: result === "timeout" };
      }
      markCancelled(id) {
        if (this.activeQueries.delete(id)) {
          this.cancelledCount++;
          if (this.draining && this.activeQueries.size === 0 && this.drainResolve) {
            this.drainResolve();
          }
        }
      }
      getStats() {
        return {
          completed: this.completedCount,
          cancelled: this.cancelledCount,
          active: this.activeQueries.size
        };
      }
      isDraining() {
        return this.draining;
      }
      reset() {
        this.activeQueries.clear();
        this.completedCount = 0;
        this.cancelledCount = 0;
        this.draining = false;
        this.drainResolve = null;
      }
    };
  }
});

// src/driver/retry.ts
function createTimeoutPromise(timeoutMs) {
  return new Promise(
    (_, reject) => setTimeout(() => reject(new Error("Health check timeout")), timeoutMs)
  );
}
var init_retry = __esm({
  "src/driver/retry.ts"() {
    "use strict";
  }
});

// src/driver/mongodb.ts
var mongodb_exports = {};
__export(mongodb_exports, {
  createMongoDriver: () => createMongoDriver,
  isMongoDriver: () => isMongoDriver
});
async function getMongoDBModule() {
  if (!mongodbModule) {
    try {
      mongodbModule = await import("mongodb");
    } catch {
      throw new Error(
        "MongoDB driver not found. Please install mongodb package: npm install mongodb"
      );
    }
  }
  return mongodbModule;
}
async function createMongoDriver(config) {
  const mongodb = await getMongoDBModule();
  const { MongoClient } = mongodb;
  const maxConnections = config.max ?? 10;
  const client = new MongoClient(config.connectionString, {
    maxPoolSize: maxConnections,
    serverSelectionTimeoutMS: config.connectTimeout ?? 5e3,
    maxIdleTimeMS: config.idleTimeout ?? 3e4
  });
  await client.connect();
  const db = client.db(config.database);
  let lastHealthCheck = createHealthCheckResult(true, 0);
  let healthCheckInterval = null;
  const healthCheckConfig = getDefaultHealthCheckConfig(config.healthCheck);
  const tracker = new QueryTracker();
  let queryIdCounter = 0;
  let draining = false;
  const generateQueryId = () => `mongo-${++queryIdCounter}`;
  async function performHealthCheck() {
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
        error instanceof Error ? error.message : "Unknown error"
      );
      if (lastHealthCheck.healthy && healthCheckConfig.onHealthChange) {
        healthCheckConfig.onHealthChange(false, result);
      }
      lastHealthCheck = result;
      return result;
    }
  }
  async function executeOperation(op) {
    const queryId = generateQueryId();
    tracker.trackQuery(queryId, `${op.type}:${op.collection}`);
    try {
      const collection = db.collection(op.collection);
      switch (op.type) {
        case "find": {
          let cursor = collection.find(op.filter ?? {});
          if (op.options?.sort) cursor = cursor.sort(op.options.sort);
          if (op.options?.skip) cursor = cursor.skip(op.options.skip);
          if (op.options?.limit) cursor = cursor.limit(op.options.limit);
          if (op.options?.projection) cursor = cursor.project(op.options.projection);
          const rows = await cursor.toArray();
          return { rows, rowCount: rows.length };
        }
        case "aggregate": {
          const result = await collection.aggregate(op.pipeline).toArray();
          return { rows: result, rowCount: result.length };
        }
        case "insertOne": {
          const result = await collection.insertOne(op.document);
          const doc = { ...op.document, _id: result.insertedId };
          return { rows: [doc], rowCount: 1 };
        }
        case "insertMany": {
          const result = await collection.insertMany(op.documents);
          return { rows: op.documents, rowCount: result.insertedCount };
        }
        case "updateOne": {
          const result = await collection.updateOne(op.filter, op.update, {
            upsert: op.options?.upsert
          });
          return { rows: [], rowCount: result.modifiedCount };
        }
        case "updateMany": {
          const result = await collection.updateMany(op.filter, op.update, {
            upsert: op.options?.upsert
          });
          return { rows: [], rowCount: result.modifiedCount };
        }
        case "deleteOne": {
          const result = await collection.deleteOne(op.filter);
          return { rows: [], rowCount: result.deletedCount };
        }
        case "deleteMany": {
          const result = await collection.deleteMany(op.filter);
          return { rows: [], rowCount: result.deletedCount };
        }
        case "findOneAndUpdate": {
          const result = await collection.findOneAndUpdate(op.filter, op.update, {
            returnDocument: op.options?.returnDocument ?? "after",
            upsert: op.options?.upsert,
            projection: op.options?.projection
          });
          return { rows: result ? [result] : [], rowCount: result ? 1 : 0 };
        }
        case "findOneAndDelete": {
          const result = await collection.findOneAndDelete(op.filter, {
            projection: op.options?.projection
          });
          return { rows: result ? [result] : [], rowCount: result ? 1 : 0 };
        }
        case "countDocuments": {
          const count = await collection.countDocuments(op.filter ?? {});
          return { rows: [{ count }], rowCount: 1 };
        }
        default:
          throw new Error(`Unsupported MongoDB operation: ${op.type}`);
      }
    } finally {
      tracker.untrackQuery(queryId);
    }
  }
  async function executeOperationWithSession(op, session) {
    const queryId = generateQueryId();
    tracker.trackQuery(queryId, `${op.type}:${op.collection}`);
    try {
      const collection = db.collection(op.collection);
      switch (op.type) {
        case "find": {
          let cursor = collection.find(op.filter ?? {}, { session });
          if (op.options?.sort) cursor = cursor.sort(op.options.sort);
          if (op.options?.skip) cursor = cursor.skip(op.options.skip);
          if (op.options?.limit) cursor = cursor.limit(op.options.limit);
          if (op.options?.projection) cursor = cursor.project(op.options.projection);
          const rows = await cursor.toArray();
          return { rows, rowCount: rows.length };
        }
        case "aggregate": {
          const result = await collection.aggregate(op.pipeline, { session }).toArray();
          return { rows: result, rowCount: result.length };
        }
        case "insertOne": {
          const result = await collection.insertOne(op.document, { session });
          const doc = { ...op.document, _id: result.insertedId };
          return { rows: [doc], rowCount: 1 };
        }
        case "insertMany": {
          const result = await collection.insertMany(op.documents, { session });
          return { rows: op.documents, rowCount: result.insertedCount };
        }
        case "updateOne": {
          const result = await collection.updateOne(op.filter, op.update, {
            upsert: op.options?.upsert,
            session
          });
          return { rows: [], rowCount: result.modifiedCount };
        }
        case "updateMany": {
          const result = await collection.updateMany(op.filter, op.update, {
            upsert: op.options?.upsert,
            session
          });
          return { rows: [], rowCount: result.modifiedCount };
        }
        case "deleteOne": {
          const result = await collection.deleteOne(op.filter, { session });
          return { rows: [], rowCount: result.deletedCount };
        }
        case "deleteMany": {
          const result = await collection.deleteMany(op.filter, { session });
          return { rows: [], rowCount: result.deletedCount };
        }
        case "findOneAndUpdate": {
          const result = await collection.findOneAndUpdate(op.filter, op.update, {
            returnDocument: op.options?.returnDocument ?? "after",
            upsert: op.options?.upsert,
            projection: op.options?.projection,
            session
          });
          return { rows: result ? [result] : [], rowCount: result ? 1 : 0 };
        }
        case "findOneAndDelete": {
          const result = await collection.findOneAndDelete(op.filter, {
            projection: op.options?.projection,
            session
          });
          return { rows: result ? [result] : [], rowCount: result ? 1 : 0 };
        }
        case "countDocuments": {
          const count = await collection.countDocuments(op.filter ?? {}, { session });
          return { rows: [{ count }], rowCount: 1 };
        }
        default:
          throw new Error(`Unsupported MongoDB operation: ${op.type}`);
      }
    } finally {
      tracker.untrackQuery(queryId);
    }
  }
  const driver = {
    dialect: "mongodb",
    connectionString: config.connectionString,
    get isDraining() {
      return draining;
    },
    async query(_sql, _params) {
      throw new Error(
        "MongoDriver does not support SQL queries. Use executeOperation() with MongoOperation instead."
      );
    },
    async execute(_sql, _params) {
      throw new Error(
        "MongoDriver does not support SQL execution. Use executeOperation() with MongoOperation instead."
      );
    },
    async transaction(fn) {
      const txQueryId = generateQueryId();
      tracker.trackQuery(txQueryId, "TRANSACTION");
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
    getActiveQueryCount() {
      return tracker.getActiveCount();
    },
    async drainAndClose(options = {}) {
      const startTime = Date.now();
      const timeout = options.timeout ?? 3e4;
      draining = true;
      const initialActive = tracker.getActiveCount();
      options.onProgress?.({
        phase: "draining",
        activeQueries: initialActive,
        completedQueries: 0,
        cancelledQueries: 0,
        elapsedMs: 0
      });
      console.log(`[db-engine] Starting graceful shutdown with ${initialActive} active queries`);
      const { timedOut } = await tracker.startDrain(timeout);
      let cancelledQueries = 0;
      if (timedOut) {
        const activeQueries = tracker.getActiveQueries();
        console.log(`[db-engine] Timeout reached, ${activeQueries.length} queries still active`);
        cancelledQueries = activeQueries.length;
        options.onProgress?.({
          phase: "cancelling",
          activeQueries: activeQueries.length,
          completedQueries: tracker.getStats().completed,
          cancelledQueries: 0,
          elapsedMs: Date.now() - startTime
        });
        for (const query of activeQueries) {
          tracker.markCancelled(query.id);
        }
      }
      options.onProgress?.({
        phase: "closing",
        activeQueries: 0,
        completedQueries: tracker.getStats().completed,
        cancelledQueries,
        elapsedMs: Date.now() - startTime
      });
      console.log("[db-engine] Closing database connection");
      await client.close(true);
      const result = {
        success: true,
        completedQueries: tracker.getStats().completed,
        cancelledQueries,
        elapsedMs: Date.now() - startTime
      };
      options.onProgress?.({
        phase: "complete",
        activeQueries: 0,
        completedQueries: result.completedQueries,
        cancelledQueries: result.cancelledQueries,
        elapsedMs: result.elapsedMs
      });
      console.log(`[db-engine] Shutdown complete in ${result.elapsedMs}ms`);
      return result;
    },
    async close() {
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
      }
      await client.close();
    },
    async healthCheck() {
      return performHealthCheck();
    },
    getPoolStats() {
      return {
        totalConnections: maxConnections,
        activeConnections: 0,
        idleConnections: maxConnections,
        waitingRequests: 0,
        maxConnections
      };
    },
    isHealthy() {
      return lastHealthCheck.healthy;
    },
    startHealthChecks() {
      if (healthCheckInterval) return;
      healthCheckInterval = setInterval(performHealthCheck, healthCheckConfig.intervalMs ?? 3e4);
      performHealthCheck();
    },
    stopHealthChecks() {
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
      }
    },
    executeOperation,
    getDb() {
      return db;
    },
    collection(name) {
      return db.collection(name);
    }
  };
  return driver;
}
function isMongoDriver(driver) {
  return driver.dialect === "mongodb" && "executeOperation" in driver;
}
var mongodbModule, MongoTransactionClientImpl;
var init_mongodb = __esm({
  "src/driver/mongodb.ts"() {
    "use strict";
    init_health();
    init_query_tracker();
    mongodbModule = null;
    MongoTransactionClientImpl = class {
      constructor(session, execWithSession) {
        this.session = session;
        this.execWithSession = execWithSession;
      }
      async query(_sql, _params) {
        throw new Error("MongoTransactionClient does not support SQL queries.");
      }
      async execute(_sql, _params) {
        throw new Error("MongoTransactionClient does not support SQL execution.");
      }
      async executeOperation(op) {
        return this.execWithSession(op, this.session);
      }
    };
  }
});

// src/driver/mysql.ts
var mysql_exports = {};
__export(mysql_exports, {
  createMySQLDriver: () => createMySQLDriver
});
async function createMySQLDriver(config) {
  const mysql = await import("mysql2/promise");
  const pool = mysql.createPool({
    uri: config.connectionString,
    waitForConnections: true,
    connectionLimit: config.max ?? 20,
    idleTimeout: (config.idleTimeout ?? 30) * 1e3,
    connectTimeout: (config.connectTimeout ?? 10) * 1e3
  });
  const maxConnections = config.max ?? 20;
  let lastHealthCheck = createHealthCheckResult(true, 0);
  let healthCheckInterval = null;
  const healthCheckConfig = getDefaultHealthCheckConfig(config.healthCheck);
  const tracker = new QueryTracker();
  let queryIdCounter = 0;
  let draining = false;
  const generateQueryId = () => `mysql-${++queryIdCounter}`;
  async function performHealthCheck() {
    const startTime = Date.now();
    try {
      const connection = await Promise.race([
        pool.getConnection(),
        createTimeoutPromise(healthCheckConfig.timeoutMs ?? 5e3)
      ]);
      await connection.ping();
      connection.release();
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
        error instanceof Error ? error.message : "Unknown error"
      );
      if (lastHealthCheck.healthy && healthCheckConfig.onHealthChange) {
        healthCheckConfig.onHealthChange(false, result);
      }
      lastHealthCheck = result;
      return result;
    }
  }
  return {
    dialect: "mysql",
    connectionString: config.connectionString,
    get isDraining() {
      return draining;
    },
    async query(queryText, params = []) {
      const queryId = generateQueryId();
      tracker.trackQuery(queryId, queryText);
      try {
        const [rows] = await pool.execute(queryText, params);
        const resultRows = Array.isArray(rows) ? rows : [];
        return {
          rows: resultRows,
          rowCount: resultRows.length
        };
      } finally {
        tracker.untrackQuery(queryId);
      }
    },
    async execute(queryText, params = []) {
      const queryId = generateQueryId();
      tracker.trackQuery(queryId, queryText);
      try {
        const [result] = await pool.execute(queryText, params);
        const affectedRows = result.affectedRows ?? 0;
        return { rowCount: affectedRows };
      } finally {
        tracker.untrackQuery(queryId);
      }
    },
    async transaction(fn) {
      const txQueryId = generateQueryId();
      tracker.trackQuery(txQueryId, "TRANSACTION");
      const connection = await pool.getConnection();
      await connection.beginTransaction();
      try {
        const client = {
          async query(queryText, params = []) {
            const [rows] = await connection.execute(queryText, params);
            const resultRows = Array.isArray(rows) ? rows : [];
            return {
              rows: resultRows,
              rowCount: resultRows.length
            };
          },
          async execute(queryText, params = []) {
            const [result2] = await connection.execute(queryText, params);
            const affectedRows = result2.affectedRows ?? 0;
            return { rowCount: affectedRows };
          }
        };
        const result = await fn(client);
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
        tracker.untrackQuery(txQueryId);
      }
    },
    getActiveQueryCount() {
      return tracker.getActiveCount();
    },
    async drainAndClose(options = {}) {
      const startTime = Date.now();
      const timeout = options.timeout ?? 3e4;
      const forceCancelOnTimeout = options.forceCancelOnTimeout ?? true;
      draining = true;
      const initialActive = tracker.getActiveCount();
      options.onProgress?.({
        phase: "draining",
        activeQueries: initialActive,
        completedQueries: 0,
        cancelledQueries: 0,
        elapsedMs: 0
      });
      console.log(`[db-engine] Starting graceful shutdown with ${initialActive} active queries`);
      const { timedOut } = await tracker.startDrain(timeout);
      let cancelledQueries = 0;
      if (timedOut && forceCancelOnTimeout) {
        const activeQueries = tracker.getActiveQueries();
        console.log(`[db-engine] Timeout reached, cancelling ${activeQueries.length} queries`);
        options.onProgress?.({
          phase: "cancelling",
          activeQueries: activeQueries.length,
          completedQueries: tracker.getStats().completed,
          cancelledQueries: 0,
          elapsedMs: Date.now() - startTime
        });
        for (const query of activeQueries) {
          if (query.backendPid) {
            try {
              await pool.execute(`KILL QUERY ${query.backendPid}`);
              tracker.markCancelled(query.id);
              cancelledQueries++;
            } catch (e) {
              console.warn(`[db-engine] Failed to cancel query ${query.id}:`, e);
            }
          } else {
            tracker.markCancelled(query.id);
            cancelledQueries++;
          }
        }
      }
      options.onProgress?.({
        phase: "closing",
        activeQueries: 0,
        completedQueries: tracker.getStats().completed,
        cancelledQueries,
        elapsedMs: Date.now() - startTime
      });
      console.log("[db-engine] Closing database connections");
      await pool.end();
      const result = {
        success: true,
        completedQueries: tracker.getStats().completed,
        cancelledQueries,
        elapsedMs: Date.now() - startTime
      };
      options.onProgress?.({
        phase: "complete",
        activeQueries: 0,
        completedQueries: result.completedQueries,
        cancelledQueries: result.cancelledQueries,
        elapsedMs: result.elapsedMs
      });
      console.log(`[db-engine] Shutdown complete in ${result.elapsedMs}ms`);
      return result;
    },
    async close() {
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
      }
      await pool.end();
    },
    async healthCheck() {
      return performHealthCheck();
    },
    getPoolStats() {
      const poolState = pool.pool;
      return {
        totalConnections: poolState?._allConnections?.length ?? 0,
        activeConnections: poolState?._acquiringConnections?.length ?? 0,
        idleConnections: poolState?._freeConnections?.length ?? 0,
        waitingRequests: poolState?._connectionQueue?.length ?? 0,
        maxConnections
      };
    },
    isHealthy() {
      return lastHealthCheck.healthy;
    },
    startHealthChecks() {
      if (healthCheckInterval) return;
      healthCheckInterval = setInterval(performHealthCheck, healthCheckConfig.intervalMs ?? 3e4);
      performHealthCheck();
    },
    stopHealthChecks() {
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
      }
    }
  };
}
var init_mysql = __esm({
  "src/driver/mysql.ts"() {
    "use strict";
    init_health();
    init_query_tracker();
    init_retry();
  }
});

// src/driver/sqlite.ts
var sqlite_exports = {};
__export(sqlite_exports, {
  createSQLiteDriver: () => createSQLiteDriver
});
async function createSQLiteDriver(config) {
  const Database = (await import("better-sqlite3")).default;
  const dbPath = config.connectionString.replace("sqlite://", "").replace("file://", "");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  let lastHealthCheck = createHealthCheckResult(true, 0);
  let healthCheckInterval = null;
  const healthCheckConfig = getDefaultHealthCheckConfig(config.healthCheck);
  const tracker = new QueryTracker();
  let queryIdCounter = 0;
  let draining = false;
  const generateQueryId = () => `sqlite-${++queryIdCounter}`;
  function performHealthCheck() {
    const startTime = Date.now();
    try {
      db.prepare("SELECT 1").get();
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
        error instanceof Error ? error.message : "Unknown error"
      );
      if (lastHealthCheck.healthy && healthCheckConfig.onHealthChange) {
        healthCheckConfig.onHealthChange(false, result);
      }
      lastHealthCheck = result;
      return result;
    }
  }
  return {
    dialect: "sqlite",
    connectionString: config.connectionString,
    get isDraining() {
      return draining;
    },
    async query(queryText, params = []) {
      const queryId = generateQueryId();
      tracker.trackQuery(queryId, queryText);
      try {
        const stmt = db.prepare(queryText);
        const rows = stmt.all(...params);
        return {
          rows,
          rowCount: rows.length
        };
      } finally {
        tracker.untrackQuery(queryId);
      }
    },
    async execute(queryText, params = []) {
      const queryId = generateQueryId();
      tracker.trackQuery(queryId, queryText);
      try {
        const stmt = db.prepare(queryText);
        const result = stmt.run(...params);
        return { rowCount: result.changes };
      } finally {
        tracker.untrackQuery(queryId);
      }
    },
    async transaction(fn) {
      const txQueryId = generateQueryId();
      tracker.trackQuery(txQueryId, "TRANSACTION");
      const client = {
        async query(queryText, params = []) {
          const stmt = db.prepare(queryText);
          const rows = stmt.all(...params);
          return {
            rows,
            rowCount: rows.length
          };
        },
        async execute(queryText, params = []) {
          const stmt = db.prepare(queryText);
          const result2 = stmt.run(...params);
          return { rowCount: result2.changes };
        }
      };
      let result;
      let committed = false;
      db.prepare("BEGIN IMMEDIATE").run();
      try {
        result = await fn(client);
        db.prepare("COMMIT").run();
        committed = true;
        return result;
      } catch (error) {
        if (!committed) {
          db.prepare("ROLLBACK").run();
        }
        throw error;
      } finally {
        tracker.untrackQuery(txQueryId);
      }
    },
    getActiveQueryCount() {
      return tracker.getActiveCount();
    },
    async drainAndClose(options = {}) {
      const startTime = Date.now();
      draining = true;
      const initialActive = tracker.getActiveCount();
      options.onProgress?.({
        phase: "draining",
        activeQueries: initialActive,
        completedQueries: 0,
        cancelledQueries: 0,
        elapsedMs: 0
      });
      console.log(`[db-engine] Starting graceful shutdown with ${initialActive} active queries`);
      options.onProgress?.({
        phase: "closing",
        activeQueries: 0,
        completedQueries: tracker.getStats().completed,
        cancelledQueries: 0,
        elapsedMs: Date.now() - startTime
      });
      console.log("[db-engine] Closing database connection");
      db.close();
      const result = {
        success: true,
        completedQueries: tracker.getStats().completed,
        cancelledQueries: 0,
        elapsedMs: Date.now() - startTime
      };
      options.onProgress?.({
        phase: "complete",
        activeQueries: 0,
        completedQueries: result.completedQueries,
        cancelledQueries: result.cancelledQueries,
        elapsedMs: result.elapsedMs
      });
      console.log(`[db-engine] Shutdown complete in ${result.elapsedMs}ms`);
      return result;
    },
    async close() {
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
      }
      db.close();
    },
    async healthCheck() {
      return performHealthCheck();
    },
    getPoolStats() {
      return {
        totalConnections: 1,
        activeConnections: lastHealthCheck.healthy ? 1 : 0,
        idleConnections: 0,
        waitingRequests: 0,
        maxConnections: 1
      };
    },
    isHealthy() {
      return lastHealthCheck.healthy;
    },
    startHealthChecks() {
      if (healthCheckInterval) return;
      healthCheckInterval = setInterval(performHealthCheck, healthCheckConfig.intervalMs ?? 3e4);
      performHealthCheck();
    },
    stopHealthChecks() {
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
      }
    }
  };
}
var init_sqlite = __esm({
  "src/driver/sqlite.ts"() {
    "use strict";
    init_health();
    init_query_tracker();
  }
});

// src/cli/index.ts
import { mkdir as mkdir2, readFile as readFile4, writeFile as writeFile2 } from "fs/promises";
import { dirname as dirname2, join as join4 } from "path";

// src/driver/postgresql.ts
init_health();
init_query_tracker();
init_retry();
import postgres from "postgres";
function createPostgresDriver(config) {
  const sql = postgres(config.connectionString, {
    max: config.max ?? 20,
    idle_timeout: config.idleTimeout ?? 30,
    connect_timeout: config.connectTimeout ?? 10,
    prepare: true
  });
  const maxConnections = config.max ?? 20;
  let lastHealthCheck = createHealthCheckResult(true, 0);
  let healthCheckInterval = null;
  const healthCheckConfig = getDefaultHealthCheckConfig(config.healthCheck);
  const tracker = new QueryTracker();
  let queryIdCounter = 0;
  let draining = false;
  const generateQueryId = () => `pg-${++queryIdCounter}`;
  async function performHealthCheck() {
    const startTime = Date.now();
    try {
      await Promise.race([
        sql`SELECT 1`,
        createTimeoutPromise(healthCheckConfig.timeoutMs ?? 5e3)
      ]);
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
        error instanceof Error ? error.message : "Unknown error"
      );
      if (lastHealthCheck.healthy && healthCheckConfig.onHealthChange) {
        healthCheckConfig.onHealthChange(false, result);
      }
      lastHealthCheck = result;
      return result;
    }
  }
  return {
    dialect: "postgresql",
    connectionString: config.connectionString,
    get isDraining() {
      return draining;
    },
    async query(queryText, params = []) {
      const queryId = generateQueryId();
      tracker.trackQuery(queryId, queryText);
      try {
        const result = await sql.unsafe(queryText, params);
        return {
          rows: result,
          rowCount: result.length
        };
      } finally {
        tracker.untrackQuery(queryId);
      }
    },
    async execute(queryText, params = []) {
      const queryId = generateQueryId();
      tracker.trackQuery(queryId, queryText);
      try {
        const result = await sql.unsafe(queryText, params);
        return { rowCount: result.count ?? 0 };
      } finally {
        tracker.untrackQuery(queryId);
      }
    },
    async transaction(fn) {
      const txQueryId = generateQueryId();
      tracker.trackQuery(txQueryId, "TRANSACTION");
      try {
        const result = await sql.begin(async (tx) => {
          const client = {
            async query(queryText, params = []) {
              const txResult = await tx.unsafe(queryText, params);
              return {
                rows: txResult,
                rowCount: txResult.length
              };
            },
            async execute(queryText, params = []) {
              const txResult = await tx.unsafe(queryText, params);
              return { rowCount: txResult.count ?? 0 };
            }
          };
          return fn(client);
        });
        return result;
      } finally {
        tracker.untrackQuery(txQueryId);
      }
    },
    getActiveQueryCount() {
      return tracker.getActiveCount();
    },
    async drainAndClose(options = {}) {
      const startTime = Date.now();
      const timeout = options.timeout ?? 3e4;
      const forceCancelOnTimeout = options.forceCancelOnTimeout ?? true;
      draining = true;
      const initialActive = tracker.getActiveCount();
      options.onProgress?.({
        phase: "draining",
        activeQueries: initialActive,
        completedQueries: 0,
        cancelledQueries: 0,
        elapsedMs: 0
      });
      console.log(`[db-engine] Starting graceful shutdown with ${initialActive} active queries`);
      const { timedOut } = await tracker.startDrain(timeout);
      let cancelledQueries = 0;
      if (timedOut && forceCancelOnTimeout) {
        const activeQueries = tracker.getActiveQueries();
        console.log(`[db-engine] Timeout reached, cancelling ${activeQueries.length} queries`);
        options.onProgress?.({
          phase: "cancelling",
          activeQueries: activeQueries.length,
          completedQueries: tracker.getStats().completed,
          cancelledQueries: 0,
          elapsedMs: Date.now() - startTime
        });
        for (const query of activeQueries) {
          try {
            await sql.unsafe(
              `SELECT pg_cancel_backend(pid) FROM pg_stat_activity
               WHERE state = 'active' AND query LIKE $1`,
              [`%${query.query.slice(0, 50)}%`]
            );
            tracker.markCancelled(query.id);
            cancelledQueries++;
          } catch (e) {
            console.warn(`[db-engine] Failed to cancel query ${query.id}:`, e);
          }
        }
      }
      options.onProgress?.({
        phase: "closing",
        activeQueries: 0,
        completedQueries: tracker.getStats().completed,
        cancelledQueries,
        elapsedMs: Date.now() - startTime
      });
      console.log("[db-engine] Closing database connections");
      await sql.end();
      const result = {
        success: true,
        completedQueries: tracker.getStats().completed,
        cancelledQueries,
        elapsedMs: Date.now() - startTime
      };
      options.onProgress?.({
        phase: "complete",
        activeQueries: 0,
        completedQueries: result.completedQueries,
        cancelledQueries: result.cancelledQueries,
        elapsedMs: result.elapsedMs
      });
      console.log(`[db-engine] Shutdown complete in ${result.elapsedMs}ms`);
      return result;
    },
    async close() {
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
      }
      await sql.end();
    },
    async healthCheck() {
      return performHealthCheck();
    },
    getPoolStats() {
      return {
        totalConnections: maxConnections,
        activeConnections: sql.connections ?? 0,
        idleConnections: maxConnections - (sql.connections ?? 0),
        waitingRequests: 0,
        maxConnections
      };
    },
    isHealthy() {
      return lastHealthCheck.healthy;
    },
    startHealthChecks() {
      if (healthCheckInterval) return;
      healthCheckInterval = setInterval(performHealthCheck, healthCheckConfig.intervalMs ?? 3e4);
      performHealthCheck();
    },
    stopHealthChecks() {
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
      }
    }
  };
}

// src/driver/index.ts
init_mongodb();
init_query_tracker();
init_health();
init_retry();
function detectDialect(connectionString) {
  if (connectionString.startsWith("mongodb://") || connectionString.startsWith("mongodb+srv://")) {
    return "mongodb";
  }
  if (connectionString.startsWith("postgres://") || connectionString.startsWith("postgresql://")) {
    return "postgresql";
  }
  if (connectionString.startsWith("mysql://") || connectionString.startsWith("mariadb://")) {
    return "mysql";
  }
  if (connectionString.startsWith("sqlite://") || connectionString.startsWith("file://") || connectionString.endsWith(".db") || connectionString.endsWith(".sqlite") || connectionString.endsWith(".sqlite3")) {
    return "sqlite";
  }
  throw new Error(`Unable to detect database dialect from connection string: ${connectionString}`);
}
async function createDriver(options) {
  const dialect = options.dialect ?? detectDialect(options.connectionString);
  switch (dialect) {
    case "postgresql":
      return createPostgresDriver(options);
    case "mysql": {
      const { createMySQLDriver: createMySQLDriver2 } = await Promise.resolve().then(() => (init_mysql(), mysql_exports));
      return createMySQLDriver2(options);
    }
    case "sqlite": {
      const { createSQLiteDriver: createSQLiteDriver2 } = await Promise.resolve().then(() => (init_sqlite(), sqlite_exports));
      return createSQLiteDriver2(options);
    }
    case "mongodb": {
      const { createMongoDriver: createMongoDriver2 } = await Promise.resolve().then(() => (init_mongodb(), mongodb_exports));
      return createMongoDriver2(options);
    }
    default:
      throw new Error(`Unsupported dialect: ${dialect}`);
  }
}

// src/migrations/dialects/mysql.ts
function compileMysqlDefault(colDef) {
  if (!colDef.default) return "";
  const defaultVal = colDef.default === "gen_random_uuid()" ? "(UUID())" : colDef.default;
  return ` DEFAULT ${defaultVal}`;
}
function compileMysqlConstraints(colDef) {
  let sql = "";
  if (colDef.primaryKey) {
    sql += " PRIMARY KEY";
  }
  sql += compileMysqlDefault(colDef);
  if (!colDef.nullable && !colDef.primaryKey) {
    sql += " NOT NULL";
  }
  if (colDef.unique && !colDef.primaryKey) {
    sql += " UNIQUE";
  }
  return sql;
}
function compileMysqlForeignKeys(tableName, columns) {
  const fkDefs = [];
  for (const [colName, colDef] of Object.entries(columns)) {
    if (colDef.references) {
      const fkName = `fk_${tableName}_${colName}`;
      let fk = `  CONSTRAINT \`${fkName}\` FOREIGN KEY (\`${colName}\`) `;
      fk += `REFERENCES \`${colDef.references.table}\`(\`${colDef.references.column}\`)`;
      if (colDef.references.onDelete) {
        fk += ` ON DELETE ${colDef.references.onDelete}`;
      }
      fkDefs.push(fk);
    }
  }
  return fkDefs;
}
var mysqlDialect = {
  name: "mysql",
  supportsTransactionalDDL: false,
  mapType(type) {
    const map = {
      uuid: "CHAR(36)",
      string: "VARCHAR(255)",
      text: "TEXT",
      integer: "INT",
      bigint: "BIGINT",
      float: "DOUBLE",
      decimal: "DECIMAL(10,2)",
      boolean: "TINYINT(1)",
      datetime: "DATETIME",
      date: "DATE",
      time: "TIME",
      json: "JSON",
      binary: "BLOB"
    };
    return map[type] || "VARCHAR(255)";
  },
  createTable(name, def) {
    const columnDefs = Object.entries(def.columns).map(([colName, colDef]) => {
      const typeSql = `  \`${colName}\` ${this.mapType(colDef.type)}`;
      return typeSql + compileMysqlConstraints(colDef);
    });
    if (def.primaryKey && def.primaryKey.length > 1) {
      columnDefs.push(`  PRIMARY KEY (${def.primaryKey.map((c) => `\`${c}\``).join(", ")})`);
    }
    const foreignKeys = compileMysqlForeignKeys(name, def.columns);
    columnDefs.push(...foreignKeys);
    return `CREATE TABLE \`${name}\` (
${columnDefs.join(",\n")}
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
  },
  dropTable(name) {
    return `DROP TABLE IF EXISTS \`${name}\``;
  },
  addColumn(table, column, def) {
    let sql = `ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${this.mapType(def.type)}`;
    if (def.default) {
      sql += ` DEFAULT ${def.default}`;
    }
    if (!def.nullable) {
      sql += " NOT NULL";
    }
    if (def.unique) {
      sql += " UNIQUE";
    }
    return sql;
  },
  dropColumn(table, column) {
    return `ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``;
  },
  alterColumn(table, column, def) {
    let sql = `ALTER TABLE \`${table}\` MODIFY COLUMN \`${column}\` ${this.mapType(def.type)}`;
    if (def.default) {
      sql += ` DEFAULT ${def.default}`;
    }
    if (!def.nullable) {
      sql += " NOT NULL";
    }
    return sql;
  },
  createIndex(table, index) {
    const indexName = index.name || `idx_${table}_${index.columns.join("_")}`;
    const unique = index.unique ? "UNIQUE " : "";
    const columns = index.columns.map((c) => `\`${c}\``).join(", ");
    return `CREATE ${unique}INDEX \`${indexName}\` ON \`${table}\` (${columns})`;
  },
  dropIndex(name, table) {
    if (!table) {
      throw new Error("MySQL requires table name for DROP INDEX");
    }
    return `DROP INDEX \`${name}\` ON \`${table}\``;
  },
  addForeignKey(table, column, refTable, refColumn, onDelete) {
    const constraintName = `fk_${table}_${column}_${refTable}`;
    let sql = `ALTER TABLE \`${table}\` ADD CONSTRAINT \`${constraintName}\` `;
    sql += `FOREIGN KEY (\`${column}\`) REFERENCES \`${refTable}\`(\`${refColumn}\`)`;
    if (onDelete) {
      sql += ` ON DELETE ${onDelete}`;
    }
    return sql;
  },
  dropForeignKey(table, constraintName) {
    return `ALTER TABLE \`${table}\` DROP FOREIGN KEY \`${constraintName}\``;
  },
  introspectTablesQuery() {
    return `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = DATABASE()
        AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `;
  },
  introspectColumnsQuery(table) {
    return `
      SELECT
        column_name,
        data_type,
        is_nullable,
        column_default,
        character_maximum_length
      FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = '${table}'
      ORDER BY ordinal_position
    `;
  },
  introspectIndexesQuery(table) {
    return `
      SELECT
        index_name,
        column_name,
        non_unique
      FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = '${table}'
      ORDER BY index_name, seq_in_index
    `;
  }
};

// src/migrations/dialects/postgresql.ts
function compilePostgresConstraints(colDef) {
  let sql = "";
  if (colDef.primaryKey) {
    sql += " PRIMARY KEY";
  }
  if (colDef.default) {
    sql += ` DEFAULT ${colDef.default}`;
  }
  if (!colDef.nullable && !colDef.primaryKey) {
    sql += " NOT NULL";
  }
  if (colDef.unique && !colDef.primaryKey) {
    sql += " UNIQUE";
  }
  return sql;
}
function compilePostgresReferences(colDef) {
  if (!colDef.references) return "";
  let sql = ` REFERENCES "${colDef.references.table}"("${colDef.references.column}")`;
  if (colDef.references.onDelete) {
    sql += ` ON DELETE ${colDef.references.onDelete}`;
  }
  if (colDef.references.onUpdate) {
    sql += ` ON UPDATE ${colDef.references.onUpdate}`;
  }
  return sql;
}
var postgresDialect = {
  name: "postgresql",
  supportsTransactionalDDL: true,
  mapType(type) {
    const map = {
      uuid: "UUID",
      string: "TEXT",
      text: "TEXT",
      integer: "INTEGER",
      bigint: "BIGINT",
      float: "DOUBLE PRECISION",
      decimal: "NUMERIC",
      boolean: "BOOLEAN",
      datetime: "TIMESTAMPTZ",
      date: "DATE",
      time: "TIME",
      json: "JSONB",
      binary: "BYTEA"
    };
    return map[type] || "TEXT";
  },
  createTable(name, def) {
    const columnDefs = Object.entries(def.columns).map(([colName, colDef]) => {
      const typeSql = `  "${colName}" ${this.mapType(colDef.type)}`;
      const constraints = compilePostgresConstraints(colDef);
      const references = compilePostgresReferences(colDef);
      return typeSql + constraints + references;
    });
    if (def.primaryKey && def.primaryKey.length > 1) {
      columnDefs.push(`  PRIMARY KEY (${def.primaryKey.map((c) => `"${c}"`).join(", ")})`);
    }
    return `CREATE TABLE "${name}" (
${columnDefs.join(",\n")}
)`;
  },
  dropTable(name) {
    return `DROP TABLE IF EXISTS "${name}" CASCADE`;
  },
  addColumn(table, column, def) {
    let sql = `ALTER TABLE "${table}" ADD COLUMN "${column}" ${this.mapType(def.type)}`;
    if (def.default) {
      sql += ` DEFAULT ${def.default}`;
    }
    if (!def.nullable) {
      sql += " NOT NULL";
    }
    if (def.unique) {
      sql += " UNIQUE";
    }
    return sql;
  },
  dropColumn(table, column) {
    return `ALTER TABLE "${table}" DROP COLUMN "${column}"`;
  },
  alterColumn(table, column, def) {
    const statements = [];
    statements.push(
      `ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE ${this.mapType(def.type)}`
    );
    if (def.nullable === false) {
      statements.push(`ALTER TABLE "${table}" ALTER COLUMN "${column}" SET NOT NULL`);
    } else if (def.nullable === true) {
      statements.push(`ALTER TABLE "${table}" ALTER COLUMN "${column}" DROP NOT NULL`);
    }
    if (def.default !== void 0) {
      statements.push(`ALTER TABLE "${table}" ALTER COLUMN "${column}" SET DEFAULT ${def.default}`);
    }
    return statements.join(";\n");
  },
  createIndex(table, index) {
    const indexName = index.name || `idx_${table}_${index.columns.join("_")}`;
    const unique = index.unique ? "UNIQUE " : "";
    const columns = index.columns.map((c) => `"${c}"`).join(", ");
    let sql = `CREATE ${unique}INDEX "${indexName}" ON "${table}" (${columns})`;
    if (index.where) {
      sql += ` WHERE ${index.where}`;
    }
    return sql;
  },
  dropIndex(name) {
    return `DROP INDEX IF EXISTS "${name}"`;
  },
  addForeignKey(table, column, refTable, refColumn, onDelete) {
    const constraintName = `fk_${table}_${column}_${refTable}`;
    let sql = `ALTER TABLE "${table}" ADD CONSTRAINT "${constraintName}" `;
    sql += `FOREIGN KEY ("${column}") REFERENCES "${refTable}"("${refColumn}")`;
    if (onDelete) {
      sql += ` ON DELETE ${onDelete}`;
    }
    return sql;
  },
  dropForeignKey(table, constraintName) {
    return `ALTER TABLE "${table}" DROP CONSTRAINT "${constraintName}"`;
  },
  introspectTablesQuery() {
    return `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `;
  },
  introspectColumnsQuery(table) {
    return `
      SELECT
        column_name,
        data_type,
        is_nullable,
        column_default,
        character_maximum_length
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = '${table}'
      ORDER BY ordinal_position
    `;
  },
  introspectIndexesQuery(table) {
    return `
      SELECT
        i.relname as index_name,
        a.attname as column_name,
        ix.indisunique as is_unique,
        ix.indisprimary as is_primary
      FROM pg_class t
      JOIN pg_index ix ON t.oid = ix.indrelid
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
      WHERE t.relname = '${table}'
      ORDER BY i.relname, a.attnum
    `;
  }
};

// src/migrations/dialects/sqlite.ts
var SQLITE_UUID_DEFAULT = "(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))))";
function compileSqliteDefault(colDef) {
  if (!colDef.default) return "";
  let defaultVal = colDef.default;
  if (colDef.default === "gen_random_uuid()") {
    defaultVal = SQLITE_UUID_DEFAULT;
  } else if (colDef.default === "now()" || colDef.default === "NOW()") {
    defaultVal = "datetime('now')";
  }
  return ` DEFAULT ${defaultVal}`;
}
function compileSqliteConstraints(colDef) {
  let sql = "";
  if (colDef.primaryKey) {
    sql += " PRIMARY KEY";
  }
  sql += compileSqliteDefault(colDef);
  if (!colDef.nullable && !colDef.primaryKey) {
    sql += " NOT NULL";
  }
  if (colDef.unique && !colDef.primaryKey) {
    sql += " UNIQUE";
  }
  return sql;
}
function compileSqliteReferences(colDef) {
  if (!colDef.references) return "";
  let sql = ` REFERENCES "${colDef.references.table}"("${colDef.references.column}")`;
  if (colDef.references.onDelete) {
    sql += ` ON DELETE ${colDef.references.onDelete}`;
  }
  return sql;
}
var sqliteDialect = {
  name: "sqlite",
  supportsTransactionalDDL: true,
  mapType(type) {
    const map = {
      uuid: "TEXT",
      string: "TEXT",
      text: "TEXT",
      integer: "INTEGER",
      bigint: "INTEGER",
      float: "REAL",
      decimal: "REAL",
      boolean: "INTEGER",
      datetime: "TEXT",
      date: "TEXT",
      time: "TEXT",
      json: "TEXT",
      binary: "BLOB"
    };
    return map[type] || "TEXT";
  },
  createTable(name, def) {
    const columnDefs = Object.entries(def.columns).map(([colName, colDef]) => {
      const typeSql = `  "${colName}" ${this.mapType(colDef.type)}`;
      const constraints = compileSqliteConstraints(colDef);
      const references = compileSqliteReferences(colDef);
      return typeSql + constraints + references;
    });
    if (def.primaryKey && def.primaryKey.length > 1) {
      columnDefs.push(`  PRIMARY KEY (${def.primaryKey.map((c) => `"${c}"`).join(", ")})`);
    }
    return `CREATE TABLE "${name}" (
${columnDefs.join(",\n")}
)`;
  },
  dropTable(name) {
    return `DROP TABLE IF EXISTS "${name}"`;
  },
  addColumn(table, column, def) {
    let sql = `ALTER TABLE "${table}" ADD COLUMN "${column}" ${this.mapType(def.type)}`;
    if (def.default) {
      sql += ` DEFAULT ${def.default}`;
    }
    return sql;
  },
  dropColumn(table, column) {
    return `ALTER TABLE "${table}" DROP COLUMN "${column}"`;
  },
  alterColumn(_table, _column, _def) {
    throw new Error(
      "SQLite does not support ALTER COLUMN. Use table recreation instead: 1. Create new table with desired schema, 2. Copy data, 3. Drop old table, 4. Rename new table"
    );
  },
  createIndex(table, index) {
    const indexName = index.name || `idx_${table}_${index.columns.join("_")}`;
    const unique = index.unique ? "UNIQUE " : "";
    const columns = index.columns.map((c) => `"${c}"`).join(", ");
    let sql = `CREATE ${unique}INDEX "${indexName}" ON "${table}" (${columns})`;
    if (index.where) {
      sql += ` WHERE ${index.where}`;
    }
    return sql;
  },
  dropIndex(name) {
    return `DROP INDEX IF EXISTS "${name}"`;
  },
  addForeignKey(_table, _column, _refTable, _refColumn, _onDelete) {
    throw new Error(
      "SQLite does not support adding foreign keys after table creation. Define foreign keys in CREATE TABLE or use table recreation."
    );
  },
  dropForeignKey(_table, _constraintName) {
    throw new Error("SQLite does not support dropping foreign keys. Use table recreation instead.");
  },
  introspectTablesQuery() {
    return `
      SELECT name as table_name
      FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `;
  },
  introspectColumnsQuery(table) {
    return `PRAGMA table_info("${table}")`;
  },
  introspectIndexesQuery(table) {
    return `PRAGMA index_list("${table}")`;
  }
};

// src/migrations/dialects/index.ts
function getDialect(name) {
  switch (name) {
    case "postgresql":
      return postgresDialect;
    case "mysql":
      return mysqlDialect;
    case "sqlite":
      return sqliteDialect;
    case "mongodb":
      throw new Error(
        "MongoDB uses a different dialect interface. Use mongoDialect and executeMongoMigration instead."
      );
    default:
      throw new Error(`Unsupported dialect: ${name}`);
  }
}

// src/migrations/runner.ts
import { createHash } from "crypto";
import { readFile, readdir } from "fs/promises";
import { join } from "path";
var MigrationRunner = class {
  driver;
  dialect;
  migrationsPath;
  tableName;
  constructor(driver, options) {
    this.driver = driver;
    this.dialect = getDialect(driver.dialect);
    this.migrationsPath = options.migrationsPath;
    this.tableName = options.tableName ?? "lp_migrations";
  }
  async ensureMigrationsTable() {
    const createTableSQL = this.dialect.name === "postgresql" ? `
        CREATE TABLE IF NOT EXISTS "${this.tableName}" (
          version BIGINT PRIMARY KEY,
          name TEXT NOT NULL,
          scope TEXT NOT NULL CHECK (scope IN ('core', 'template')),
          template_key TEXT,
          module_name TEXT,
          checksum TEXT NOT NULL,
          up_sql TEXT[] NOT NULL,
          down_sql TEXT[],
          applied_at TIMESTAMPTZ DEFAULT NOW(),
          executed_by TEXT
        )
      ` : this.dialect.name === "mysql" ? `
          CREATE TABLE IF NOT EXISTS \`${this.tableName}\` (
            version BIGINT PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            scope VARCHAR(20) NOT NULL,
            template_key VARCHAR(255),
            module_name VARCHAR(255),
            checksum VARCHAR(64) NOT NULL,
            up_sql JSON NOT NULL,
            down_sql JSON,
            applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            executed_by VARCHAR(255)
          )
        ` : `
          CREATE TABLE IF NOT EXISTS "${this.tableName}" (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            scope TEXT NOT NULL CHECK (scope IN ('core', 'template')),
            template_key TEXT,
            module_name TEXT,
            checksum TEXT NOT NULL,
            up_sql TEXT NOT NULL,
            down_sql TEXT,
            applied_at TEXT DEFAULT (datetime('now')),
            executed_by TEXT
          )
        `;
    await this.driver.execute(createTableSQL);
    if (this.dialect.name === "postgresql") {
      await this.driver.execute(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_${this.tableName}_scope_version
        ON "${this.tableName}" (scope, COALESCE(template_key, ''), version)
      `);
    }
  }
  async up(options = {}) {
    await this.ensureMigrationsTable();
    const pending = await this.getPendingMigrations(options);
    const results = [];
    let migrationsToRun = pending;
    if (options.steps) {
      migrationsToRun = pending.slice(0, options.steps);
    }
    if (options.toVersion) {
      migrationsToRun = pending.filter((m) => m.version <= options.toVersion);
    }
    for (const migration of migrationsToRun) {
      const startTime = Date.now();
      if (options.dryRun) {
        console.log(`[DRY RUN] Would apply migration: ${migration.version}__${migration.name}`);
        console.log(migration.up.join("\n"));
        results.push({
          version: migration.version,
          name: migration.name,
          success: true,
          duration: 0
        });
        continue;
      }
      try {
        if (this.dialect.supportsTransactionalDDL) {
          await this.driver.transaction(async (trx) => {
            for (const sql of migration.up) {
              await trx.execute(sql);
            }
            await this.recordMigration(trx, migration);
          });
        } else {
          for (const sql of migration.up) {
            await this.driver.execute(sql);
          }
          await this.recordMigration(this.driver, migration);
        }
        results.push({
          version: migration.version,
          name: migration.name,
          success: true,
          duration: Date.now() - startTime
        });
      } catch (error) {
        results.push({
          version: migration.version,
          name: migration.name,
          success: false,
          error: error instanceof Error ? error.message : String(error),
          duration: Date.now() - startTime
        });
        break;
      }
    }
    return results;
  }
  async down(options = {}) {
    await this.ensureMigrationsTable();
    const applied = await this.getAppliedMigrations(options);
    const results = [];
    let migrationsToRollback = applied.reverse();
    if (options.steps) {
      migrationsToRollback = migrationsToRollback.slice(0, options.steps);
    }
    if (options.toVersion) {
      migrationsToRollback = migrationsToRollback.filter((m) => m.version > options.toVersion);
    }
    for (const migration of migrationsToRollback) {
      if (!migration.downSql?.length) {
        results.push({
          version: migration.version,
          name: migration.name,
          success: false,
          error: "No down migration available",
          duration: 0
        });
        break;
      }
      const startTime = Date.now();
      if (options.dryRun) {
        console.log(`[DRY RUN] Would rollback migration: ${migration.version}__${migration.name}`);
        console.log(migration.downSql.join("\n"));
        results.push({
          version: migration.version,
          name: migration.name,
          success: true,
          duration: 0
        });
        continue;
      }
      try {
        if (this.dialect.supportsTransactionalDDL) {
          await this.driver.transaction(async (trx) => {
            for (const sql of migration.downSql) {
              await trx.execute(sql);
            }
            await this.removeMigrationRecord(trx, migration.version);
          });
        } else {
          for (const sql of migration.downSql) {
            await this.driver.execute(sql);
          }
          await this.removeMigrationRecord(this.driver, migration.version);
        }
        results.push({
          version: migration.version,
          name: migration.name,
          success: true,
          duration: Date.now() - startTime
        });
      } catch (error) {
        results.push({
          version: migration.version,
          name: migration.name,
          success: false,
          error: error instanceof Error ? error.message : String(error),
          duration: Date.now() - startTime
        });
        break;
      }
    }
    return results;
  }
  async status(options = {}) {
    await this.ensureMigrationsTable();
    const applied = await this.getAppliedMigrations(options);
    const pending = await this.getPendingMigrations(options);
    const current = applied.length ? applied[applied.length - 1].version : null;
    return { applied, pending, current };
  }
  async verify(options = {}) {
    await this.ensureMigrationsTable();
    const applied = await this.getAppliedMigrations(options);
    const files = await this.loadMigrationFiles(options);
    const issues = [];
    for (const record of applied) {
      const file = files.find((f) => f.version === record.version);
      if (!file) {
        issues.push(`Migration ${record.version}__${record.name} was applied but file is missing`);
        continue;
      }
      const fileChecksum = this.computeChecksum(file.up);
      if (fileChecksum !== record.checksum) {
        issues.push(
          `Migration ${record.version}__${record.name} checksum mismatch. File has been modified after being applied.`
        );
      }
    }
    return { valid: issues.length === 0, issues };
  }
  sanitizeTemplateKey(templateKey) {
    if (!/^[a-zA-Z0-9_-]+$/.test(templateKey)) {
      throw new Error(
        `Invalid templateKey: "${templateKey}". Only alphanumeric characters, hyphens, and underscores are allowed.`
      );
    }
    return templateKey;
  }
  async loadMigrationFiles(options = {}) {
    const scope = options.scope ?? "core";
    let dirPath;
    if (scope === "template" && options.templateKey) {
      const sanitizedKey = this.sanitizeTemplateKey(options.templateKey);
      dirPath = join(this.migrationsPath, "templates", sanitizedKey);
    } else {
      dirPath = join(this.migrationsPath, "core");
    }
    try {
      const files = await readdir(dirPath);
      const sqlFiles = files.filter((f) => f.endsWith(".sql")).sort();
      const migrations = [];
      for (const file of sqlFiles) {
        const content = await readFile(join(dirPath, file), "utf-8");
        const parsed = this.parseMigrationFile(file, content, scope, options.templateKey);
        if (parsed) {
          migrations.push(parsed);
        }
      }
      return migrations;
    } catch (error) {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }
  parseMigrationFile(filename, content, scope, templateKey) {
    const match = filename.match(/^(\d+)__(.+)\.sql$/);
    if (!match) return null;
    const [, versionStr, name] = match;
    const version = Number.parseInt(versionStr, 10);
    const upMatch = content.match(/--\s*up\s*\n([\s\S]*?)(?=--\s*down|$)/i);
    const downMatch = content.match(/--\s*down\s*\n([\s\S]*?)$/i);
    const up = upMatch ? this.splitSqlStatements(upMatch[1]) : [];
    const down = downMatch ? this.splitSqlStatements(downMatch[1]) : [];
    if (!up.length) return null;
    return {
      version,
      name,
      up,
      down,
      scope,
      templateKey
    };
  }
  async getAppliedMigrations(options = {}) {
    const scope = options.scope ?? "core";
    const templateKey = options.templateKey ?? null;
    const moduleName = options.moduleName ?? null;
    let sql;
    let params;
    if (this.dialect.name === "postgresql") {
      sql = `
        SELECT version, name, scope, template_key, module_name, checksum, up_sql, down_sql, applied_at, executed_by
        FROM "${this.tableName}"
        WHERE scope = $1 AND (template_key = $2 OR (template_key IS NULL AND $2 IS NULL))
          AND (module_name = $3 OR (module_name IS NULL AND $3 IS NULL))
        ORDER BY version ASC
      `;
      params = [scope, templateKey, moduleName];
    } else {
      sql = `
        SELECT version, name, scope, template_key, module_name, checksum, up_sql, down_sql, applied_at, executed_by
        FROM ${this.dialect.name === "mysql" ? `\`${this.tableName}\`` : `"${this.tableName}"`}
        WHERE scope = ? AND (template_key = ? OR (template_key IS NULL AND ? IS NULL))
          AND (module_name = ? OR (module_name IS NULL AND ? IS NULL))
        ORDER BY version ASC
      `;
      params = [scope, templateKey, templateKey, moduleName, moduleName];
    }
    const result = await this.driver.query(sql, params);
    return result.rows.map((row) => ({
      version: Number(row.version),
      name: row.name,
      scope: row.scope,
      templateKey: row.template_key,
      moduleName: row.module_name,
      checksum: row.checksum,
      upSql: typeof row.up_sql === "string" ? JSON.parse(row.up_sql) : row.up_sql,
      downSql: row.down_sql ? typeof row.down_sql === "string" ? JSON.parse(row.down_sql) : row.down_sql : [],
      appliedAt: new Date(row.applied_at),
      executedBy: row.executed_by
    }));
  }
  async getPendingMigrations(options = {}) {
    const files = await this.loadMigrationFiles(options);
    const applied = await this.getAppliedMigrations(options);
    const appliedVersions = new Set(applied.map((m) => m.version));
    return files.filter((f) => !appliedVersions.has(f.version));
  }
  async recordMigration(client, migration) {
    const checksum = this.computeChecksum(migration.up);
    if (this.dialect.name === "postgresql") {
      await client.execute(
        `
        INSERT INTO "${this.tableName}" (version, name, scope, template_key, module_name, checksum, up_sql, down_sql)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        [
          migration.version,
          migration.name,
          migration.scope,
          migration.templateKey ?? null,
          migration.moduleName ?? null,
          checksum,
          migration.up,
          migration.down.length ? migration.down : null
        ]
      );
    } else if (this.dialect.name === "mysql") {
      await client.execute(
        `
        INSERT INTO \`${this.tableName}\` (version, name, scope, template_key, module_name, checksum, up_sql, down_sql)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          migration.version,
          migration.name,
          migration.scope,
          migration.templateKey ?? null,
          migration.moduleName ?? null,
          checksum,
          JSON.stringify(migration.up),
          migration.down.length ? JSON.stringify(migration.down) : null
        ]
      );
    } else {
      await client.execute(
        `
        INSERT INTO "${this.tableName}" (version, name, scope, template_key, module_name, checksum, up_sql, down_sql)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          migration.version,
          migration.name,
          migration.scope,
          migration.templateKey ?? null,
          migration.moduleName ?? null,
          checksum,
          JSON.stringify(migration.up),
          migration.down.length ? JSON.stringify(migration.down) : null
        ]
      );
    }
  }
  async removeMigrationRecord(client, version) {
    if (this.dialect.name === "postgresql") {
      await client.execute(`DELETE FROM "${this.tableName}" WHERE version = $1`, [version]);
    } else {
      await client.execute(
        `DELETE FROM ${this.dialect.name === "mysql" ? `\`${this.tableName}\`` : `"${this.tableName}"`} WHERE version = ?`,
        [version]
      );
    }
  }
  computeChecksum(statements) {
    return createHash("sha256").update(statements.join("\n")).digest("hex");
  }
  splitSqlStatements(sql) {
    const statements = [];
    let current = "";
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inDollarQuote = false;
    let dollarTag = "";
    let inLineComment = false;
    let inBlockComment = false;
    for (let i = 0; i < sql.length; i++) {
      const char = sql[i];
      const next = sql[i + 1] || "";
      if (inLineComment) {
        current += char;
        if (char === "\n") {
          inLineComment = false;
        }
        continue;
      }
      if (inBlockComment) {
        current += char;
        if (char === "*" && next === "/") {
          current += next;
          i++;
          inBlockComment = false;
        }
        continue;
      }
      if (inDollarQuote) {
        current += char;
        if (char === "$") {
          const endTag = sql.slice(i).match(/^\$[a-zA-Z0-9_]*\$/);
          if (endTag && endTag[0] === dollarTag) {
            current += sql.slice(i + 1, i + dollarTag.length);
            i += dollarTag.length - 1;
            inDollarQuote = false;
            dollarTag = "";
          }
        }
        continue;
      }
      if (inSingleQuote) {
        current += char;
        if (char === "'" && next !== "'") {
          inSingleQuote = false;
        } else if (char === "'" && next === "'") {
          current += next;
          i++;
        }
        continue;
      }
      if (inDoubleQuote) {
        current += char;
        if (char === '"' && next !== '"') {
          inDoubleQuote = false;
        } else if (char === '"' && next === '"') {
          current += next;
          i++;
        }
        continue;
      }
      if (char === "-" && next === "-") {
        inLineComment = true;
        current += char;
        continue;
      }
      if (char === "/" && next === "*") {
        inBlockComment = true;
        current += char;
        continue;
      }
      if (char === "$") {
        const tag = sql.slice(i).match(/^\$[a-zA-Z0-9_]*\$/);
        if (tag) {
          inDollarQuote = true;
          dollarTag = tag[0];
          current += dollarTag;
          i += dollarTag.length - 1;
          continue;
        }
      }
      if (char === "'") {
        inSingleQuote = true;
        current += char;
        continue;
      }
      if (char === '"') {
        inDoubleQuote = true;
        current += char;
        continue;
      }
      if (char === ";") {
        const trimmed2 = current.trim();
        if (trimmed2) {
          statements.push(trimmed2);
        }
        current = "";
        continue;
      }
      current += char;
    }
    const trimmed = current.trim();
    if (trimmed) {
      statements.push(trimmed);
    }
    return statements;
  }
};

// src/modules/collector.ts
import { readFile as readFile2, readdir as readdir2, stat } from "fs/promises";
import { join as join2 } from "path";
var MigrationCollector = class {
  async discoverFromDirectory(basePath) {
    const sources = [];
    try {
      const entries = await readdir2(basePath);
      for (const entry of entries) {
        const entryPath = join2(basePath, entry);
        const entryStat = await stat(entryPath);
        if (entryStat.isDirectory()) {
          sources.push({
            moduleName: entry,
            migrationsPath: entryPath
          });
        }
      }
    } catch (error) {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
    return sources.sort((a, b) => a.moduleName.localeCompare(b.moduleName));
  }
  async collect(sources, options = {}) {
    const migrations = [];
    for (const source of sources) {
      const sourceMigrations = await this.loadMigrationsFromSource(source, options);
      migrations.push(...sourceMigrations);
    }
    return this.orderMigrations(migrations);
  }
  async loadMigrationsFromSource(source, options = {}) {
    const scope = options.scope ?? "core";
    const migrations = [];
    try {
      const files = await readdir2(source.migrationsPath);
      const sqlFiles = files.filter((f) => f.endsWith(".sql")).sort();
      for (const file of sqlFiles) {
        const content = await readFile2(join2(source.migrationsPath, file), "utf-8");
        const parsed = this.parseMigrationFile(file, content, scope, source.moduleName);
        if (parsed) {
          migrations.push(parsed);
        }
      }
    } catch (error) {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
    return migrations;
  }
  parseMigrationFile(filename, content, scope, moduleName) {
    const match = filename.match(/^(\d+)__(.+)\.sql$/);
    if (!match) return null;
    const [, versionStr, name] = match;
    const version = Number.parseInt(versionStr, 10);
    const upMatch = content.match(/--\s*up\s*\n([\s\S]*?)(?=--\s*down|$)/i);
    const downMatch = content.match(/--\s*down\s*\n([\s\S]*?)$/i);
    const up = upMatch ? this.splitSqlStatements(upMatch[1]) : [];
    const down = downMatch ? this.splitSqlStatements(downMatch[1]) : [];
    if (!up.length) return null;
    return {
      version,
      name,
      up,
      down,
      scope,
      moduleName
    };
  }
  orderMigrations(migrations) {
    return migrations.sort((a, b) => {
      if (a.version !== b.version) {
        return a.version - b.version;
      }
      const moduleA = a.moduleName ?? "";
      const moduleB = b.moduleName ?? "";
      return moduleA.localeCompare(moduleB);
    });
  }
  splitSqlStatements(sql) {
    const statements = [];
    let current = "";
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inDollarQuote = false;
    let dollarTag = "";
    let inLineComment = false;
    let inBlockComment = false;
    for (let i = 0; i < sql.length; i++) {
      const char = sql[i];
      const next = sql[i + 1] || "";
      if (inLineComment) {
        current += char;
        if (char === "\n") {
          inLineComment = false;
        }
        continue;
      }
      if (inBlockComment) {
        current += char;
        if (char === "*" && next === "/") {
          current += next;
          i++;
          inBlockComment = false;
        }
        continue;
      }
      if (inDollarQuote) {
        current += char;
        if (char === "$") {
          const endTag = sql.slice(i).match(/^\$[a-zA-Z0-9_]*\$/);
          if (endTag && endTag[0] === dollarTag) {
            current += sql.slice(i + 1, i + dollarTag.length);
            i += dollarTag.length - 1;
            inDollarQuote = false;
            dollarTag = "";
          }
        }
        continue;
      }
      if (inSingleQuote) {
        current += char;
        if (char === "'" && next !== "'") {
          inSingleQuote = false;
        } else if (char === "'" && next === "'") {
          current += next;
          i++;
        }
        continue;
      }
      if (inDoubleQuote) {
        current += char;
        if (char === '"' && next !== '"') {
          inDoubleQuote = false;
        } else if (char === '"' && next === '"') {
          current += next;
          i++;
        }
        continue;
      }
      if (char === "-" && next === "-") {
        inLineComment = true;
        current += char;
        continue;
      }
      if (char === "/" && next === "*") {
        inBlockComment = true;
        current += char;
        continue;
      }
      if (char === "$") {
        const tag = sql.slice(i).match(/^\$[a-zA-Z0-9_]*\$/);
        if (tag) {
          inDollarQuote = true;
          dollarTag = tag[0];
          current += dollarTag;
          i += dollarTag.length - 1;
          continue;
        }
      }
      if (char === "'") {
        inSingleQuote = true;
        current += char;
        continue;
      }
      if (char === '"') {
        inDoubleQuote = true;
        current += char;
        continue;
      }
      if (char === ";") {
        const trimmed2 = current.trim();
        if (trimmed2) {
          statements.push(trimmed2);
        }
        current = "";
        continue;
      }
      current += char;
    }
    const trimmed = current.trim();
    if (trimmed) {
      statements.push(trimmed);
    }
    return statements;
  }
};

// src/modules/registry.ts
var ModuleRegistry = class {
  driver;
  dialect;
  tableName;
  constructor(driver, options = {}) {
    this.driver = driver;
    this.dialect = getDialect(driver.dialect);
    this.tableName = options.tableName ?? "lp_module_registry";
  }
  async ensureTable() {
    const createTableSQL = this.dialect.name === "postgresql" ? `
        CREATE TABLE IF NOT EXISTS "${this.tableName}" (
          name TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          description TEXT,
          version TEXT NOT NULL,
          dependencies TEXT[] DEFAULT '{}',
          migration_prefix TEXT NOT NULL UNIQUE,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      ` : this.dialect.name === "mysql" ? `
          CREATE TABLE IF NOT EXISTS \`${this.tableName}\` (
            name VARCHAR(255) PRIMARY KEY,
            display_name VARCHAR(255) NOT NULL,
            description TEXT,
            version VARCHAR(50) NOT NULL,
            dependencies JSON DEFAULT ('[]'),
            migration_prefix VARCHAR(255) NOT NULL UNIQUE,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
          )
        ` : `
          CREATE TABLE IF NOT EXISTS "${this.tableName}" (
            name TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            description TEXT,
            version TEXT NOT NULL,
            dependencies TEXT DEFAULT '[]',
            migration_prefix TEXT NOT NULL UNIQUE,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
          )
        `;
    await this.driver.execute(createTableSQL);
  }
  async register(module) {
    await this.ensureTable();
    const dependencies = module.dependencies ?? [];
    if (this.dialect.name === "postgresql") {
      await this.driver.execute(
        `
        INSERT INTO "${this.tableName}" (name, display_name, description, version, dependencies, migration_prefix)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (name) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          description = EXCLUDED.description,
          version = EXCLUDED.version,
          dependencies = EXCLUDED.dependencies,
          migration_prefix = EXCLUDED.migration_prefix,
          updated_at = NOW()
        `,
        [
          module.name,
          module.displayName,
          module.description ?? null,
          module.version,
          dependencies,
          module.migrationPrefix
        ]
      );
    } else if (this.dialect.name === "mysql") {
      await this.driver.execute(
        `
        INSERT INTO \`${this.tableName}\` (name, display_name, description, version, dependencies, migration_prefix)
        VALUES (?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          display_name = VALUES(display_name),
          description = VALUES(description),
          version = VALUES(version),
          dependencies = VALUES(dependencies),
          migration_prefix = VALUES(migration_prefix)
        `,
        [
          module.name,
          module.displayName,
          module.description ?? null,
          module.version,
          JSON.stringify(dependencies),
          module.migrationPrefix
        ]
      );
    } else {
      await this.driver.execute(
        `
        INSERT INTO "${this.tableName}" (name, display_name, description, version, dependencies, migration_prefix)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (name) DO UPDATE SET
          display_name = excluded.display_name,
          description = excluded.description,
          version = excluded.version,
          dependencies = excluded.dependencies,
          migration_prefix = excluded.migration_prefix,
          updated_at = datetime('now')
        `,
        [
          module.name,
          module.displayName,
          module.description ?? null,
          module.version,
          JSON.stringify(dependencies),
          module.migrationPrefix
        ]
      );
    }
  }
  async get(name) {
    await this.ensureTable();
    let sql;
    let params;
    if (this.dialect.name === "postgresql") {
      sql = `
        SELECT name, display_name, description, version, dependencies, migration_prefix
        FROM "${this.tableName}"
        WHERE name = $1
      `;
      params = [name];
    } else {
      sql = `
        SELECT name, display_name, description, version, dependencies, migration_prefix
        FROM ${this.dialect.name === "mysql" ? `\`${this.tableName}\`` : `"${this.tableName}"`}
        WHERE name = ?
      `;
      params = [name];
    }
    const result = await this.driver.query(sql, params);
    if (result.rows.length === 0) {
      return null;
    }
    const row = result.rows[0];
    return {
      name: row.name,
      displayName: row.display_name,
      description: row.description ?? void 0,
      version: row.version,
      dependencies: typeof row.dependencies === "string" ? JSON.parse(row.dependencies) : row.dependencies,
      migrationPrefix: row.migration_prefix
    };
  }
  async list() {
    await this.ensureTable();
    const sql = this.dialect.name === "postgresql" ? `
        SELECT name, display_name, description, version, dependencies, migration_prefix
        FROM "${this.tableName}"
        ORDER BY name ASC
      ` : `
        SELECT name, display_name, description, version, dependencies, migration_prefix
        FROM ${this.dialect.name === "mysql" ? `\`${this.tableName}\`` : `"${this.tableName}"`}
        ORDER BY name ASC
      `;
    const result = await this.driver.query(sql);
    return result.rows.map((row) => ({
      name: row.name,
      displayName: row.display_name,
      description: row.description ?? void 0,
      version: row.version,
      dependencies: typeof row.dependencies === "string" ? JSON.parse(row.dependencies) : row.dependencies,
      migrationPrefix: row.migration_prefix
    }));
  }
  async unregister(name) {
    await this.ensureTable();
    if (this.dialect.name === "postgresql") {
      await this.driver.execute(`DELETE FROM "${this.tableName}" WHERE name = $1`, [name]);
    } else {
      await this.driver.execute(
        `DELETE FROM ${this.dialect.name === "mysql" ? `\`${this.tableName}\`` : `"${this.tableName}"`} WHERE name = ?`,
        [name]
      );
    }
  }
};

// src/remote/auth.ts
import { mkdir, readFile as readFile3, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join as join3 } from "path";

// src/schema/types.ts
var SchemaRemoteError = class extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
    this.name = "SchemaRemoteError";
  }
};
var BreakingChangeError = class extends Error {
  constructor(message, changes = []) {
    super(message);
    this.changes = changes;
    this.name = "BreakingChangeError";
  }
};
var AuthenticationError = class extends Error {
  constructor(message = "Authentication failed. Run `launchpad login` to authenticate.") {
    super(message);
    this.name = "AuthenticationError";
  }
};
var UserCancelledError = class extends Error {
  constructor(message = "Operation cancelled by user.") {
    super(message);
    this.name = "UserCancelledError";
  }
};

// src/remote/auth.ts
var DEFAULT_CREDENTIALS_PATH = join3(homedir(), ".launchpad", "credentials.json");
var AuthHandler = class {
  credentialsPath;
  cachedCredentials = null;
  constructor(config = {}) {
    this.credentialsPath = config.credentialsPath ?? DEFAULT_CREDENTIALS_PATH;
  }
  async getToken() {
    const credentials = await this.loadCredentials();
    if (!credentials?.token) {
      throw new AuthenticationError(
        "No authentication token found. Run `launchpad login` to authenticate."
      );
    }
    if (credentials.expiresAt) {
      const expiresAt = new Date(credentials.expiresAt);
      if (expiresAt <= /* @__PURE__ */ new Date()) {
        if (credentials.refreshToken) {
          return this.refreshToken(credentials.refreshToken);
        }
        throw new AuthenticationError(
          "Authentication token has expired. Run `launchpad login` to re-authenticate."
        );
      }
    }
    return credentials.token;
  }
  async getProjectId() {
    const credentials = await this.loadCredentials();
    return credentials?.projectId;
  }
  async saveCredentials(credentials) {
    await mkdir(dirname(this.credentialsPath), { recursive: true });
    await writeFile(this.credentialsPath, JSON.stringify(credentials, null, 2), "utf-8");
    this.cachedCredentials = credentials;
  }
  async clearCredentials() {
    try {
      await writeFile(this.credentialsPath, "{}", "utf-8");
      this.cachedCredentials = null;
    } catch {
    }
  }
  async isAuthenticated() {
    try {
      await this.getToken();
      return true;
    } catch {
      return false;
    }
  }
  async loadCredentials() {
    if (this.cachedCredentials) {
      return this.cachedCredentials;
    }
    try {
      const content = await readFile3(this.credentialsPath, "utf-8");
      this.cachedCredentials = JSON.parse(content);
      return this.cachedCredentials;
    } catch {
      return null;
    }
  }
  async refreshToken(_refreshToken) {
    throw new AuthenticationError(
      "Token refresh not implemented. Run `launchpad login` to re-authenticate."
    );
  }
};
function createAuthHandler(config) {
  return new AuthHandler(config);
}

// src/remote/client.ts
var SchemaRemoteClient = class {
  apiUrl;
  projectId;
  authToken;
  timeout;
  retries;
  schemaCache = /* @__PURE__ */ new Map();
  CACHE_TTL = 5 * 60 * 1e3;
  constructor(config, options = {}) {
    this.apiUrl = config.apiUrl.replace(/\/$/, "");
    this.projectId = config.projectId;
    this.authToken = config.authToken;
    this.timeout = options.timeout ?? 3e4;
    this.retries = options.retries ?? 3;
  }
  async fetchSchema(environment = "production") {
    const cacheKey = `${this.projectId}-${environment}`;
    const cached = this.schemaCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < this.CACHE_TTL) {
      return cached.schema;
    }
    const response = await this.request(
      "GET",
      `/v1/projects/${this.projectId}/schema`,
      void 0,
      { "X-Environment": environment }
    );
    this.schemaCache.set(cacheKey, {
      schema: response,
      cachedAt: Date.now()
    });
    return response;
  }
  async pushMigration(migration, options = {}) {
    const environment = options.environment ?? "production";
    this.schemaCache.delete(`${this.projectId}-${environment}`);
    return this.request(
      "POST",
      `/v1/projects/${this.projectId}/schema/migrations`,
      {
        migration,
        dryRun: options.dryRun ?? false,
        force: options.force ?? false
      },
      { "X-Environment": environment }
    );
  }
  async getSyncStatus(environment = "production") {
    return this.request(
      "GET",
      `/v1/projects/${this.projectId}/schema/sync-status`,
      void 0,
      { "X-Environment": environment }
    );
  }
  async healthCheck() {
    return this.request("GET", "/v1/health");
  }
  clearCache() {
    this.schemaCache.clear();
  }
  async request(method, path, body, additionalHeaders) {
    const url = `${this.apiUrl}${path}`;
    const headers = {
      Authorization: `Bearer ${this.authToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...additionalHeaders
    };
    let lastError = null;
    for (let attempt = 0; attempt < this.retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);
        const response = await fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : void 0,
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (!response.ok) {
          if (response.status === 401) {
            throw new AuthenticationError("Invalid or expired authentication token.");
          }
          if (response.status === 403) {
            throw new SchemaRemoteError("Permission denied. Check your API key permissions.", 403);
          }
          if (response.status === 404) {
            throw new SchemaRemoteError(`Project not found: ${this.projectId}`, 404);
          }
          if (response.status >= 500 && attempt < this.retries - 1) {
            await this.delay(2 ** attempt * 1e3);
            continue;
          }
          const errorBody = await response.text();
          let errorMessage;
          try {
            const parsed = JSON.parse(errorBody);
            errorMessage = parsed.message || parsed.error || errorBody;
          } catch {
            errorMessage = errorBody || response.statusText;
          }
          throw new SchemaRemoteError(errorMessage, response.status);
        }
        return await response.json();
      } catch (error) {
        if (error instanceof AuthenticationError || error instanceof SchemaRemoteError) {
          throw error;
        }
        lastError = error instanceof Error ? error : new Error(String(error));
        if (error instanceof Error && error.name === "AbortError") {
          lastError = new SchemaRemoteError(`Request timeout after ${this.timeout}ms`);
        }
        if (attempt < this.retries - 1) {
          await this.delay(2 ** attempt * 1e3);
        }
      }
    }
    throw lastError ?? new SchemaRemoteError("Request failed after retries");
  }
  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
};
function createSchemaRemoteClient(config, options) {
  return new SchemaRemoteClient(config, options);
}

// src/schema/registry.ts
import { createHash as createHash2 } from "crypto";
var SchemaRegistry = class {
  driver;
  dialect;
  tableName;
  constructor(driver, options = {}) {
    this.driver = driver;
    this.dialect = getDialect(driver.dialect);
    this.tableName = options.tableName ?? "lp_schema_registry";
  }
  async ensureRegistryTable() {
    const createTableSQL = this.dialect.name === "postgresql" ? `
        CREATE TABLE IF NOT EXISTS "${this.tableName}" (
          app_id TEXT NOT NULL,
          schema_name TEXT NOT NULL,
          version TEXT NOT NULL,
          schema JSONB NOT NULL,
          checksum TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (app_id, schema_name)
        )
      ` : this.dialect.name === "mysql" ? `
          CREATE TABLE IF NOT EXISTS \`${this.tableName}\` (
            app_id VARCHAR(255) NOT NULL,
            schema_name VARCHAR(255) NOT NULL,
            version VARCHAR(50) NOT NULL,
            schema JSON NOT NULL,
            checksum VARCHAR(64) NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (app_id, schema_name)
          )
        ` : `
          CREATE TABLE IF NOT EXISTS "${this.tableName}" (
            app_id TEXT NOT NULL,
            schema_name TEXT NOT NULL,
            version TEXT NOT NULL,
            schema TEXT NOT NULL,
            checksum TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            PRIMARY KEY (app_id, schema_name)
          )
        `;
    await this.driver.execute(createTableSQL);
  }
  async register(options) {
    await this.ensureRegistryTable();
    this.validateSchema(options.schema);
    const current = await this.getCurrentSchema(options.appId, options.schemaName);
    const diff = this.computeDiff(current?.schema ?? null, options.schema);
    if (diff.length === 0) {
      return [];
    }
    const results = [];
    const checksum = this.computeChecksum(options.schema);
    if (this.dialect.supportsTransactionalDDL) {
      await this.driver.transaction(async (trx) => {
        for (const change of diff) {
          const startTime = Date.now();
          try {
            await trx.execute(change.sql);
            results.push({
              version: Date.now(),
              name: change.description,
              success: true,
              duration: Date.now() - startTime
            });
          } catch (error) {
            results.push({
              version: Date.now(),
              name: change.description,
              success: false,
              error: error instanceof Error ? error.message : String(error),
              duration: Date.now() - startTime
            });
            throw error;
          }
        }
        await this.upsertSchemaRecord(trx, {
          appId: options.appId,
          schemaName: options.schemaName,
          version: options.version,
          schema: options.schema,
          checksum
        });
      });
    } else {
      for (const change of diff) {
        const startTime = Date.now();
        try {
          await this.driver.execute(change.sql);
          results.push({
            version: Date.now(),
            name: change.description,
            success: true,
            duration: Date.now() - startTime
          });
        } catch (error) {
          results.push({
            version: Date.now(),
            name: change.description,
            success: false,
            error: error instanceof Error ? error.message : String(error),
            duration: Date.now() - startTime
          });
          throw error;
        }
      }
      await this.upsertSchemaRecord(this.driver, {
        appId: options.appId,
        schemaName: options.schemaName,
        version: options.version,
        schema: options.schema,
        checksum
      });
    }
    return results;
  }
  async getCurrentSchema(appId, schemaName) {
    let sql;
    let params;
    if (this.dialect.name === "postgresql") {
      sql = `
        SELECT app_id, schema_name, version, schema, checksum, created_at, updated_at
        FROM "${this.tableName}"
        WHERE app_id = $1 AND schema_name = $2
      `;
      params = [appId, schemaName];
    } else {
      sql = `
        SELECT app_id, schema_name, version, schema, checksum, created_at, updated_at
        FROM ${this.dialect.name === "mysql" ? `\`${this.tableName}\`` : `"${this.tableName}"`}
        WHERE app_id = ? AND schema_name = ?
      `;
      params = [appId, schemaName];
    }
    const result = await this.driver.query(sql, params);
    if (!result.rows.length) return null;
    const row = result.rows[0];
    return {
      app_id: row.app_id,
      schema_name: row.schema_name,
      version: row.version,
      schema: typeof row.schema === "string" ? JSON.parse(row.schema) : row.schema,
      checksum: row.checksum,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at)
    };
  }
  async listSchemas(appId) {
    let sql;
    let params;
    if (this.dialect.name === "postgresql") {
      sql = appId ? `SELECT * FROM "${this.tableName}" WHERE app_id = $1 ORDER BY schema_name` : `SELECT * FROM "${this.tableName}" ORDER BY app_id, schema_name`;
      params = appId ? [appId] : [];
    } else {
      const table = this.dialect.name === "mysql" ? `\`${this.tableName}\`` : `"${this.tableName}"`;
      sql = appId ? `SELECT * FROM ${table} WHERE app_id = ? ORDER BY schema_name` : `SELECT * FROM ${table} ORDER BY app_id, schema_name`;
      params = appId ? [appId] : [];
    }
    const result = await this.driver.query(sql, params);
    return result.rows.map((row) => ({
      app_id: row.app_id,
      schema_name: row.schema_name,
      version: row.version,
      schema: typeof row.schema === "string" ? JSON.parse(row.schema) : row.schema,
      checksum: row.checksum,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at)
    }));
  }
  validateSchema(schema) {
    for (const [tableName, table] of Object.entries(schema.tables)) {
      if (!table.columns.app_id) {
        throw new Error(`Table "${tableName}" must have an "app_id" column for multi-tenancy`);
      }
      if (!table.columns.organization_id) {
        throw new Error(
          `Table "${tableName}" must have an "organization_id" column for multi-tenancy`
        );
      }
      if (!table.columns.id) {
        throw new Error(`Table "${tableName}" must have an "id" column`);
      }
      const appIdCol = table.columns.app_id;
      const orgIdCol = table.columns.organization_id;
      if (!appIdCol.tenant) {
        throw new Error(`Column "app_id" in table "${tableName}" must be marked as tenant column`);
      }
      if (!orgIdCol.tenant) {
        throw new Error(
          `Column "organization_id" in table "${tableName}" must be marked as tenant column`
        );
      }
    }
  }
  computeDiff(current, desired) {
    const changes = [];
    for (const [tableName, desiredTable] of Object.entries(desired.tables)) {
      const currentTable = current?.tables[tableName];
      if (!currentTable) {
        const sql = this.dialect.createTable(tableName, desiredTable);
        changes.push({ sql, description: `Create table ${tableName}` });
        if (desiredTable.indexes) {
          for (const index of desiredTable.indexes) {
            const indexSql = this.dialect.createIndex(tableName, index);
            changes.push({
              sql: indexSql,
              description: `Create index on ${tableName}(${index.columns.join(", ")})`
            });
          }
        }
        continue;
      }
      for (const [colName, desiredCol] of Object.entries(desiredTable.columns)) {
        const currentCol = currentTable.columns[colName];
        if (!currentCol) {
          const sql = this.dialect.addColumn(tableName, colName, desiredCol);
          changes.push({ sql, description: `Add column ${tableName}.${colName}` });
        } else if (!this.columnsEqual(currentCol, desiredCol)) {
          try {
            const sql = this.dialect.alterColumn(tableName, colName, desiredCol);
            changes.push({ sql, description: `Alter column ${tableName}.${colName}` });
          } catch (error) {
            console.warn(`Cannot alter column ${tableName}.${colName}: ${error}`);
          }
        }
      }
      for (const colName of Object.keys(currentTable.columns)) {
        if (!desiredTable.columns[colName]) {
          try {
            const sql = this.dialect.dropColumn(tableName, colName);
            changes.push({ sql, description: `Drop column ${tableName}.${colName}` });
          } catch (error) {
            console.warn(`Cannot drop column ${tableName}.${colName}: ${error}`);
          }
        }
      }
    }
    if (current) {
      for (const tableName of Object.keys(current.tables)) {
        if (!desired.tables[tableName]) {
          const sql = this.dialect.dropTable(tableName);
          changes.push({ sql, description: `Drop table ${tableName}` });
        }
      }
    }
    return changes;
  }
  columnsEqual(a, b) {
    return a.type === b.type && a.nullable === b.nullable && a.unique === b.unique && a.default === b.default && JSON.stringify(a.references) === JSON.stringify(b.references);
  }
  async upsertSchemaRecord(client, data) {
    const schemaJson = JSON.stringify(data.schema);
    if (this.dialect.name === "postgresql") {
      await client.execute(
        `
        INSERT INTO "${this.tableName}" (app_id, schema_name, version, schema, checksum)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (app_id, schema_name) DO UPDATE SET
          version = EXCLUDED.version,
          schema = EXCLUDED.schema,
          checksum = EXCLUDED.checksum,
          updated_at = NOW()
        `,
        [data.appId, data.schemaName, data.version, schemaJson, data.checksum]
      );
    } else if (this.dialect.name === "mysql") {
      await client.execute(
        `
        INSERT INTO \`${this.tableName}\` (app_id, schema_name, version, schema, checksum)
        VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          version = VALUES(version),
          schema = VALUES(schema),
          checksum = VALUES(checksum)
        `,
        [data.appId, data.schemaName, data.version, schemaJson, data.checksum]
      );
    } else {
      await client.execute(
        `
        INSERT OR REPLACE INTO "${this.tableName}" (app_id, schema_name, version, schema, checksum, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        `,
        [data.appId, data.schemaName, data.version, schemaJson, data.checksum]
      );
    }
  }
  computeChecksum(schema) {
    return createHash2("sha256").update(JSON.stringify(schema)).digest("hex");
  }
};

// src/schema/introspect.ts
var SchemaIntrospector = class {
  constructor(driver, dialect) {
    this.driver = driver;
    this.dialect = dialect;
  }
  async introspect(options = {}) {
    const tables = await this.introspectTables(options);
    const enums = await this.introspectEnums();
    const extensions = await this.introspectExtensions();
    const databaseVersion = await this.getDatabaseVersion();
    return {
      tables,
      enums,
      extensions,
      introspectedAt: /* @__PURE__ */ new Date(),
      databaseVersion
    };
  }
  async introspectTables(options = {}) {
    const tableNames = await this.listTables(options);
    const tables = [];
    for (const tableName of tableNames) {
      const table = await this.introspectTable(tableName);
      tables.push(table);
    }
    return tables;
  }
  async listTables(options = {}) {
    const excludePatterns = options.includeLaunchpadTables ? [] : ["lp_%", "pg_%", "sql_%"];
    const additionalExcludes = options.excludeTables ?? [];
    let sql;
    if (this.dialect.name === "postgresql") {
      sql = `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `;
    } else if (this.dialect.name === "mysql") {
      sql = `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = DATABASE()
          AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `;
    } else {
      sql = `
        SELECT name as table_name
        FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `;
    }
    const result = await this.driver.query(sql);
    return result.rows.map((row) => row.table_name).filter((name) => {
      for (const pattern of excludePatterns) {
        if (pattern.endsWith("%")) {
          const prefix = pattern.slice(0, -1);
          if (name.startsWith(prefix)) return false;
        } else if (name === pattern) {
          return false;
        }
      }
      for (const exclude of additionalExcludes) {
        if (name === exclude) return false;
      }
      return true;
    });
  }
  async introspectTable(tableName) {
    const [columns, indexes, foreignKeys, constraints] = await Promise.all([
      this.introspectColumns(tableName),
      this.introspectIndexes(tableName),
      this.introspectForeignKeys(tableName),
      this.introspectConstraints(tableName)
    ]);
    const primaryKey = this.extractPrimaryKey(indexes);
    return {
      name: tableName,
      schema: "public",
      columns,
      primaryKey,
      foreignKeys,
      indexes: indexes.filter((i) => !i.isPrimary),
      constraints
    };
  }
  async introspectColumns(tableName) {
    if (this.dialect.name === "postgresql") {
      return this.introspectPostgresColumns(tableName);
    }
    if (this.dialect.name === "mysql") {
      return this.introspectMysqlColumns(tableName);
    }
    return this.introspectSqliteColumns(tableName);
  }
  async introspectPostgresColumns(tableName) {
    const sql = `
      SELECT
        column_name,
        data_type,
        udt_name,
        is_nullable,
        column_default,
        character_maximum_length,
        numeric_precision,
        numeric_scale,
        is_identity,
        identity_generation
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
      ORDER BY ordinal_position
    `;
    const result = await this.driver.query(sql, [tableName]);
    return result.rows.map((row) => ({
      name: row.column_name,
      dataType: row.data_type,
      udtName: row.udt_name,
      isNullable: row.is_nullable === "YES",
      defaultValue: row.column_default,
      maxLength: row.character_maximum_length,
      numericPrecision: row.numeric_precision,
      numericScale: row.numeric_scale,
      isIdentity: row.is_identity === "YES",
      identityGeneration: row.identity_generation
    }));
  }
  async introspectMysqlColumns(tableName) {
    const sql = `
      SELECT
        column_name,
        data_type,
        column_type as udt_name,
        is_nullable,
        column_default,
        character_maximum_length,
        numeric_precision,
        numeric_scale,
        extra
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = ?
      ORDER BY ordinal_position
    `;
    const result = await this.driver.query(sql, [tableName]);
    return result.rows.map((row) => ({
      name: row.column_name,
      dataType: row.data_type,
      udtName: row.udt_name,
      isNullable: row.is_nullable === "YES",
      defaultValue: row.column_default,
      maxLength: row.character_maximum_length,
      numericPrecision: row.numeric_precision,
      numericScale: row.numeric_scale,
      isIdentity: row.extra.includes("auto_increment"),
      identityGeneration: row.extra.includes("auto_increment") ? "ALWAYS" : null
    }));
  }
  async introspectSqliteColumns(tableName) {
    const sql = `PRAGMA table_info("${tableName}")`;
    const result = await this.driver.query(sql);
    return result.rows.map((row) => ({
      name: row.name,
      dataType: row.type.toLowerCase(),
      udtName: row.type.toLowerCase(),
      isNullable: row.notnull === 0,
      defaultValue: row.dflt_value,
      maxLength: null,
      numericPrecision: null,
      numericScale: null,
      isIdentity: row.pk === 1 && row.type.toLowerCase() === "integer",
      identityGeneration: row.pk === 1 && row.type.toLowerCase() === "integer" ? "ALWAYS" : null
    }));
  }
  async introspectIndexes(tableName) {
    if (this.dialect.name === "postgresql") {
      return this.introspectPostgresIndexes(tableName);
    }
    if (this.dialect.name === "mysql") {
      return this.introspectMysqlIndexes(tableName);
    }
    return this.introspectSqliteIndexes(tableName);
  }
  async introspectPostgresIndexes(tableName) {
    const sql = `
      SELECT
        i.relname AS index_name,
        array_agg(a.attname ORDER BY array_position(ix.indkey, a.attnum)) AS columns,
        ix.indisunique AS is_unique,
        ix.indisprimary AS is_primary,
        am.amname AS index_type,
        pg_get_expr(ix.indexprs, ix.indrelid) AS expression
      FROM pg_index ix
      JOIN pg_class i ON ix.indexrelid = i.oid
      JOIN pg_class t ON ix.indrelid = t.oid
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
      JOIN pg_am am ON i.relam = am.oid
      WHERE t.relname = $1
        AND t.relnamespace = 'public'::regnamespace
      GROUP BY i.relname, ix.indisunique, ix.indisprimary, am.amname, ix.indexprs, ix.indrelid
    `;
    const result = await this.driver.query(sql, [tableName]);
    return result.rows.map((row) => ({
      name: row.index_name,
      columns: row.columns,
      isUnique: row.is_unique,
      isPrimary: row.is_primary,
      type: row.index_type,
      expression: row.expression
    }));
  }
  async introspectMysqlIndexes(tableName) {
    const sql = `
      SELECT
        index_name,
        GROUP_CONCAT(column_name ORDER BY seq_in_index) as columns,
        NOT non_unique as is_unique,
        index_name = 'PRIMARY' as is_primary,
        index_type
      FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND table_name = ?
      GROUP BY index_name, non_unique, index_type
    `;
    const result = await this.driver.query(sql, [tableName]);
    return result.rows.map((row) => ({
      name: row.index_name,
      columns: row.columns.split(","),
      isUnique: row.is_unique,
      isPrimary: row.is_primary,
      type: row.index_type.toLowerCase(),
      expression: null
    }));
  }
  async introspectSqliteIndexes(tableName) {
    const indexListSql = `PRAGMA index_list("${tableName}")`;
    const indexList = await this.driver.query(indexListSql);
    const indexes = [];
    for (const idx of indexList.rows) {
      const indexInfoSql = `PRAGMA index_info("${idx.name}")`;
      const indexInfo = await this.driver.query(indexInfoSql);
      indexes.push({
        name: idx.name,
        columns: indexInfo.rows.map((row) => row.name),
        isUnique: idx.unique === 1,
        isPrimary: idx.origin === "pk",
        type: "btree",
        expression: null
      });
    }
    return indexes;
  }
  async introspectForeignKeys(tableName) {
    if (this.dialect.name === "postgresql") {
      return this.introspectPostgresForeignKeys(tableName);
    }
    if (this.dialect.name === "mysql") {
      return this.introspectMysqlForeignKeys(tableName);
    }
    return this.introspectSqliteForeignKeys(tableName);
  }
  async introspectPostgresForeignKeys(tableName) {
    const sql = `
      SELECT
        tc.constraint_name,
        array_agg(kcu.column_name ORDER BY kcu.ordinal_position) AS columns,
        ccu.table_name AS referenced_table,
        array_agg(ccu.column_name ORDER BY kcu.ordinal_position) AS referenced_columns,
        rc.delete_rule AS on_delete,
        rc.update_rule AS on_update
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      JOIN information_schema.referential_constraints rc
        ON rc.constraint_name = tc.constraint_name
        AND rc.constraint_schema = tc.table_schema
      WHERE tc.table_name = $1
        AND tc.table_schema = 'public'
        AND tc.constraint_type = 'FOREIGN KEY'
      GROUP BY tc.constraint_name, ccu.table_name, rc.delete_rule, rc.update_rule
    `;
    const result = await this.driver.query(sql, [tableName]);
    return result.rows.map((row) => ({
      name: row.constraint_name,
      columns: row.columns,
      referencedTable: row.referenced_table,
      referencedColumns: row.referenced_columns,
      onDelete: row.on_delete,
      onUpdate: row.on_update
    }));
  }
  async introspectMysqlForeignKeys(tableName) {
    const sql = `
      SELECT
        constraint_name,
        GROUP_CONCAT(column_name ORDER BY ordinal_position) as columns,
        referenced_table_name as referenced_table,
        GROUP_CONCAT(referenced_column_name ORDER BY ordinal_position) as referenced_columns
      FROM information_schema.key_column_usage
      WHERE table_schema = DATABASE()
        AND table_name = ?
        AND referenced_table_name IS NOT NULL
      GROUP BY constraint_name, referenced_table_name
    `;
    const result = await this.driver.query(sql, [tableName]);
    return result.rows.map((row) => ({
      name: row.constraint_name,
      columns: row.columns.split(","),
      referencedTable: row.referenced_table,
      referencedColumns: row.referenced_columns.split(","),
      onDelete: "NO ACTION",
      onUpdate: "NO ACTION"
    }));
  }
  async introspectSqliteForeignKeys(tableName) {
    const sql = `PRAGMA foreign_key_list("${tableName}")`;
    const result = await this.driver.query(sql);
    const fkMap = /* @__PURE__ */ new Map();
    for (const row of result.rows) {
      if (!fkMap.has(row.id)) {
        fkMap.set(row.id, {
          name: `fk_${tableName}_${row.id}`,
          columns: [],
          referencedTable: row.table,
          referencedColumns: [],
          onDelete: row.on_delete.replace(" ", "_"),
          onUpdate: row.on_update.replace(" ", "_")
        });
      }
      const fk = fkMap.get(row.id);
      fk.columns.push(row.from);
      fk.referencedColumns.push(row.to);
    }
    return Array.from(fkMap.values());
  }
  async introspectConstraints(tableName) {
    if (this.dialect.name !== "postgresql") {
      return [];
    }
    const sql = `
      SELECT
        con.conname AS constraint_name,
        CASE con.contype
          WHEN 'c' THEN 'CHECK'
          WHEN 'u' THEN 'UNIQUE'
          WHEN 'p' THEN 'PRIMARY KEY'
          WHEN 'f' THEN 'FOREIGN KEY'
          WHEN 'x' THEN 'EXCLUDE'
        END AS constraint_type,
        pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
      WHERE rel.relname = $1
        AND nsp.nspname = 'public'
        AND con.contype = 'c'
    `;
    const result = await this.driver.query(sql, [tableName]);
    return result.rows.map((row) => ({
      name: row.constraint_name,
      type: row.constraint_type,
      definition: row.definition
    }));
  }
  async introspectEnums() {
    if (this.dialect.name !== "postgresql") {
      return [];
    }
    const sql = `
      SELECT
        t.typname AS name,
        array_agg(e.enumlabel ORDER BY e.enumsortorder) AS values
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
      JOIN pg_namespace n ON t.typnamespace = n.oid
      WHERE n.nspname = 'public'
      GROUP BY t.typname
    `;
    const result = await this.driver.query(sql);
    return result.rows;
  }
  async introspectExtensions() {
    if (this.dialect.name !== "postgresql") {
      return [];
    }
    const sql = `SELECT extname FROM pg_extension WHERE extname != 'plpgsql'`;
    const result = await this.driver.query(sql);
    return result.rows.map((row) => row.extname);
  }
  async getDatabaseVersion() {
    if (this.dialect.name === "postgresql") {
      const result2 = await this.driver.query("SELECT version()");
      return result2.rows[0]?.version ?? "unknown";
    }
    if (this.dialect.name === "mysql") {
      const result2 = await this.driver.query("SELECT VERSION() as version");
      return result2.rows[0]?.version ?? "unknown";
    }
    const result = await this.driver.query(
      "SELECT sqlite_version()"
    );
    return result.rows[0]?.["sqlite_version()"] ?? "unknown";
  }
  extractPrimaryKey(indexes) {
    const pkIndex = indexes.find((i) => i.isPrimary);
    return pkIndex?.columns ?? [];
  }
  toSchemaDefinition(result) {
    const tables = {};
    for (const table of result.tables) {
      tables[table.name] = this.tableToDefinition(table);
    }
    return { tables };
  }
  tableToDefinition(table) {
    const columns = {};
    for (const col of table.columns) {
      columns[col.name] = this.columnToDefinition(col, table);
    }
    const indexes = table.indexes.map((idx) => ({
      name: idx.name,
      columns: idx.columns,
      unique: idx.isUnique
    }));
    return {
      columns,
      indexes: indexes.length > 0 ? indexes : void 0,
      primaryKey: table.primaryKey.length > 1 ? table.primaryKey : void 0
    };
  }
  columnToDefinition(col, table) {
    const type = this.mapDataTypeToColumnType(col.dataType, col.udtName);
    const isPrimaryKey = table.primaryKey.length === 1 && table.primaryKey[0] === col.name;
    const def = {
      type,
      nullable: col.isNullable
    };
    if (isPrimaryKey) {
      def.primaryKey = true;
    }
    if (col.defaultValue !== null) {
      def.default = col.defaultValue;
    }
    const fk = table.foreignKeys.find(
      (fk2) => fk2.columns.length === 1 && fk2.columns[0] === col.name
    );
    if (fk) {
      def.references = {
        table: fk.referencedTable,
        column: fk.referencedColumns[0],
        onDelete: fk.onDelete,
        onUpdate: fk.onUpdate
      };
    }
    if (col.name === "app_id" || col.name === "organization_id") {
      def.tenant = true;
    }
    return def;
  }
  mapDataTypeToColumnType(dataType, udtName) {
    const normalized = dataType.toLowerCase();
    const udt = udtName.toLowerCase();
    if (udt === "uuid" || normalized === "uuid") return "uuid";
    if (normalized.includes("int") && normalized !== "interval") return "integer";
    if (normalized === "bigint" || udt === "int8") return "bigint";
    if (normalized.includes("float") || normalized.includes("double") || normalized === "real")
      return "float";
    if (normalized.includes("numeric") || normalized.includes("decimal")) return "decimal";
    if (normalized === "boolean" || normalized === "bool") return "boolean";
    if (normalized.includes("timestamp") || normalized === "datetime") return "datetime";
    if (normalized === "date") return "date";
    if (normalized === "time") return "time";
    if (normalized === "json" || normalized === "jsonb") return "json";
    if (normalized === "bytea" || normalized.includes("blob") || normalized === "binary")
      return "binary";
    if (normalized === "text" || udt === "text") return "text";
    return "string";
  }
};

// src/schema/diff.ts
import { createHash as createHash3 } from "crypto";
var SchemaDiffEngine = class {
  constructor(dialect) {
    this.dialect = dialect;
  }
  computeDiff(current, target, options = {}) {
    const changes = [];
    const currentTables = new Set(Object.keys(current?.tables ?? {}));
    const targetTables = new Set(Object.keys(target.tables));
    for (const tableName of targetTables) {
      if (!currentTables.has(tableName)) {
        const tableChanges = this.generateTableAddChanges(tableName, target.tables[tableName]);
        changes.push(...tableChanges);
      }
    }
    for (const tableName of currentTables) {
      if (!targetTables.has(tableName)) {
        changes.push(this.generateTableDropChange(tableName, current.tables[tableName], options));
      }
    }
    for (const tableName of currentTables) {
      if (targetTables.has(tableName)) {
        const columnChanges = this.compareColumns(
          tableName,
          current.tables[tableName],
          target.tables[tableName],
          options
        );
        changes.push(...columnChanges);
        const indexChanges = this.compareIndexes(
          tableName,
          current.tables[tableName],
          target.tables[tableName]
        );
        changes.push(...indexChanges);
      }
    }
    const breakingChanges = changes.filter((c) => c.isBreaking);
    const summary = this.summarizeChanges(changes);
    let migration = null;
    if (options.generateMigration !== false && changes.length > 0) {
      migration = this.generateMigration(changes, options.migrationName);
    }
    return {
      hasDifferences: changes.length > 0,
      summary,
      changes,
      breakingChanges,
      migration
    };
  }
  generateTableAddChanges(tableName, table) {
    const changes = [];
    const createSql = this.dialect.createTable(tableName, table);
    const dropSql = this.dialect.dropTable(tableName);
    changes.push({
      type: "table_add",
      tableName,
      isBreaking: false,
      description: `Add table "${tableName}"`,
      upSql: createSql,
      downSql: dropSql
    });
    if (table.indexes) {
      for (const index of table.indexes) {
        const indexSql = this.dialect.createIndex(tableName, index);
        const dropIndexSql = this.dialect.dropIndex(
          index.name ?? `idx_${tableName}_${index.columns.join("_")}`
        );
        changes.push({
          type: "index_add",
          tableName,
          objectName: index.name ?? `idx_${tableName}_${index.columns.join("_")}`,
          isBreaking: false,
          description: `Add index on "${tableName}"(${index.columns.join(", ")})`,
          upSql: indexSql,
          downSql: dropIndexSql
        });
      }
    }
    return changes;
  }
  generateTableDropChange(tableName, table, options) {
    const dropSql = this.dialect.dropTable(tableName);
    const createSql = this.dialect.createTable(tableName, table);
    return {
      type: "table_drop",
      tableName,
      isBreaking: options.treatTableDropAsBreaking !== false,
      description: `Drop table "${tableName}"`,
      upSql: dropSql,
      downSql: createSql,
      oldValue: table
    };
  }
  compareColumns(tableName, current, target, options) {
    const changes = [];
    const currentCols = new Set(Object.keys(current.columns));
    const targetCols = new Set(Object.keys(target.columns));
    for (const colName of targetCols) {
      if (!currentCols.has(colName)) {
        const colDef = target.columns[colName];
        const addSql = this.dialect.addColumn(tableName, colName, colDef);
        const dropSql = this.dialect.dropColumn(tableName, colName);
        changes.push({
          type: "column_add",
          tableName,
          objectName: colName,
          isBreaking: false,
          description: `Add column "${tableName}"."${colName}"`,
          upSql: addSql,
          downSql: dropSql,
          newValue: colDef
        });
        if (colDef.references) {
          const fkName = `fk_${tableName}_${colName}_${colDef.references.table}`;
          const addFkSql = this.dialect.addForeignKey(
            tableName,
            colName,
            colDef.references.table,
            colDef.references.column,
            colDef.references.onDelete
          );
          const dropFkSql = this.dialect.dropForeignKey(tableName, fkName);
          changes.push({
            type: "foreign_key_add",
            tableName,
            objectName: fkName,
            isBreaking: false,
            description: `Add foreign key "${tableName}"."${colName}" -> "${colDef.references.table}"`,
            upSql: addFkSql,
            downSql: dropFkSql,
            newValue: colDef.references
          });
        }
      }
    }
    for (const colName of currentCols) {
      if (!targetCols.has(colName)) {
        const colDef = current.columns[colName];
        const dropSql = this.dialect.dropColumn(tableName, colName);
        const addSql = this.dialect.addColumn(tableName, colName, colDef);
        changes.push({
          type: "column_drop",
          tableName,
          objectName: colName,
          isBreaking: options.treatColumnDropAsBreaking !== false,
          description: `Drop column "${tableName}"."${colName}"`,
          upSql: dropSql,
          downSql: addSql,
          oldValue: colDef
        });
      }
    }
    for (const colName of currentCols) {
      if (targetCols.has(colName)) {
        const currentCol = current.columns[colName];
        const targetCol = target.columns[colName];
        if (!this.columnsEqual(currentCol, targetCol)) {
          const alteration = this.generateColumnAlteration(
            tableName,
            colName,
            currentCol,
            targetCol
          );
          if (alteration) {
            changes.push(alteration);
          }
        }
      }
    }
    return changes;
  }
  compareIndexes(tableName, current, target) {
    const changes = [];
    const currentIndexes = /* @__PURE__ */ new Map();
    const targetIndexes = /* @__PURE__ */ new Map();
    for (const idx of current.indexes ?? []) {
      const key = idx.name ?? `idx_${tableName}_${idx.columns.join("_")}`;
      currentIndexes.set(key, idx);
    }
    for (const idx of target.indexes ?? []) {
      const key = idx.name ?? `idx_${tableName}_${idx.columns.join("_")}`;
      targetIndexes.set(key, idx);
    }
    for (const [name, idx] of targetIndexes) {
      if (!currentIndexes.has(name)) {
        const addSql = this.dialect.createIndex(tableName, idx);
        const dropSql = this.dialect.dropIndex(name);
        changes.push({
          type: "index_add",
          tableName,
          objectName: name,
          isBreaking: false,
          description: `Add index "${name}" on "${tableName}"`,
          upSql: addSql,
          downSql: dropSql,
          newValue: idx
        });
      }
    }
    for (const [name, idx] of currentIndexes) {
      if (!targetIndexes.has(name)) {
        const dropSql = this.dialect.dropIndex(name);
        const addSql = this.dialect.createIndex(tableName, idx);
        changes.push({
          type: "index_drop",
          tableName,
          objectName: name,
          isBreaking: false,
          description: `Drop index "${name}" from "${tableName}"`,
          upSql: dropSql,
          downSql: addSql,
          oldValue: idx
        });
      }
    }
    return changes;
  }
  generateColumnAlteration(tableName, colName, current, target) {
    const isBreaking = this.isColumnChangeBreaking(current, target);
    try {
      const alterSql = this.dialect.alterColumn(tableName, colName, target);
      const revertSql = this.dialect.alterColumn(tableName, colName, current);
      return {
        type: "column_modify",
        tableName,
        objectName: colName,
        isBreaking,
        description: `Modify column "${tableName}"."${colName}"`,
        upSql: alterSql,
        downSql: revertSql,
        oldValue: current,
        newValue: target
      };
    } catch {
      return null;
    }
  }
  isColumnChangeBreaking(current, target) {
    if (target.nullable === false && current.nullable === true) {
      return true;
    }
    const typeOrder = {
      uuid: 10,
      boolean: 20,
      integer: 30,
      bigint: 40,
      float: 50,
      decimal: 60,
      string: 70,
      text: 80,
      date: 90,
      time: 100,
      datetime: 110,
      json: 120,
      binary: 130
    };
    const currentOrder = typeOrder[current.type] ?? 0;
    const targetOrder = typeOrder[target.type] ?? 0;
    if (targetOrder < currentOrder) {
      return true;
    }
    return false;
  }
  columnsEqual(a, b) {
    return a.type === b.type && (a.nullable ?? false) === (b.nullable ?? false) && (a.unique ?? false) === (b.unique ?? false) && a.default === b.default && JSON.stringify(a.references) === JSON.stringify(b.references);
  }
  summarizeChanges(changes) {
    const summary = {
      tablesAdded: 0,
      tablesDropped: 0,
      tablesModified: 0,
      columnsAdded: 0,
      columnsDropped: 0,
      columnsModified: 0,
      indexesAdded: 0,
      indexesDropped: 0,
      foreignKeysAdded: 0,
      foreignKeysDropped: 0
    };
    const modifiedTables = /* @__PURE__ */ new Set();
    for (const change of changes) {
      switch (change.type) {
        case "table_add":
          summary.tablesAdded++;
          break;
        case "table_drop":
          summary.tablesDropped++;
          break;
        case "column_add":
          summary.columnsAdded++;
          modifiedTables.add(change.tableName);
          break;
        case "column_drop":
          summary.columnsDropped++;
          modifiedTables.add(change.tableName);
          break;
        case "column_modify":
          summary.columnsModified++;
          modifiedTables.add(change.tableName);
          break;
        case "index_add":
          summary.indexesAdded++;
          break;
        case "index_drop":
          summary.indexesDropped++;
          break;
        case "foreign_key_add":
          summary.foreignKeysAdded++;
          break;
        case "foreign_key_drop":
          summary.foreignKeysDropped++;
          break;
      }
    }
    summary.tablesModified = modifiedTables.size;
    return summary;
  }
  generateMigration(changes, name) {
    const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
    const migrationName = name ?? "schema_sync";
    const version = `${timestamp}`;
    const upSql = changes.map((c) => c.upSql);
    const downSql = changes.slice().reverse().map((c) => c.downSql);
    const content = [...upSql, ...downSql].join("\n");
    const checksum = createHash3("sha256").update(content).digest("hex");
    return {
      version,
      name: migrationName,
      upSql,
      downSql,
      checksum
    };
  }
  formatDiff(diff, format = "text") {
    if (format === "json") {
      return JSON.stringify(diff, null, 2);
    }
    if (format === "sql") {
      if (!diff.migration) return "-- No changes";
      return `-- Up
${diff.migration.upSql.join(";\n")};

-- Down
${diff.migration.downSql.join(";\n")};`;
    }
    const lines = [];
    lines.push("\u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510");
    lines.push("\u2502                     Schema Diff: local \u2194 remote                  \u2502");
    lines.push("\u251C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524");
    if (!diff.hasDifferences) {
      lines.push("\u2502  No differences found                                            \u2502");
      lines.push("\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518");
      return lines.join("\n");
    }
    lines.push("\u2502 Summary:                                                          \u2502");
    if (diff.summary.tablesAdded > 0) {
      lines.push(
        `\u2502   + ${diff.summary.tablesAdded} table(s) added                                             \u2502`
      );
    }
    if (diff.summary.tablesDropped > 0) {
      lines.push(
        `\u2502   - ${diff.summary.tablesDropped} table(s) dropped (BREAKING)                               \u2502`
      );
    }
    if (diff.summary.columnsAdded > 0) {
      lines.push(
        `\u2502   + ${diff.summary.columnsAdded} column(s) added                                            \u2502`
      );
    }
    if (diff.summary.columnsDropped > 0) {
      lines.push(
        `\u2502   - ${diff.summary.columnsDropped} column(s) dropped (BREAKING)                              \u2502`
      );
    }
    if (diff.summary.columnsModified > 0) {
      lines.push(
        `\u2502   ~ ${diff.summary.columnsModified} column(s) modified                                        \u2502`
      );
    }
    if (diff.summary.indexesAdded > 0) {
      lines.push(
        `\u2502   + ${diff.summary.indexesAdded} index(es) added                                             \u2502`
      );
    }
    if (diff.summary.indexesDropped > 0) {
      lines.push(
        `\u2502   - ${diff.summary.indexesDropped} index(es) dropped                                          \u2502`
      );
    }
    lines.push("\u251C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524");
    for (const change of diff.changes) {
      const prefix = change.type.includes("add") ? "+" : change.type.includes("drop") ? "-" : "~";
      const breaking = change.isBreaking ? " (BREAKING)" : "";
      lines.push(`\u2502 ${prefix} ${change.description}${breaking}`);
    }
    lines.push("\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518");
    if (diff.breakingChanges.length > 0) {
      lines.push("");
      lines.push(
        `\u26A0\uFE0F  ${diff.breakingChanges.length} breaking change(s) detected. Use --force to apply.`
      );
    }
    return lines.join("\n");
  }
};

// src/schema/sync.ts
import { createHash as createHash4 } from "crypto";

// src/schema/sync-metadata.ts
var SyncMetadataManager = class {
  constructor(driver, dialect, options = {}) {
    this.driver = driver;
    this.dialect = dialect;
    this.tableName = options.tableName ?? "lp_schema_sync";
  }
  tableName;
  async ensureSyncTable() {
    let sql;
    if (this.dialect.name === "postgresql") {
      sql = `
        CREATE TABLE IF NOT EXISTS "${this.tableName}" (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          app_id TEXT NOT NULL,
          table_name TEXT NOT NULL,
          local_checksum TEXT,
          local_version TEXT,
          local_updated_at TIMESTAMPTZ,
          remote_checksum TEXT,
          remote_version TEXT,
          remote_updated_at TIMESTAMPTZ,
          sync_status TEXT NOT NULL DEFAULT 'unknown',
          last_sync_at TIMESTAMPTZ,
          last_sync_direction TEXT,
          last_sync_by TEXT,
          base_checksum TEXT,
          conflict_details JSONB,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(app_id, table_name)
        )
      `;
    } else if (this.dialect.name === "mysql") {
      sql = `
        CREATE TABLE IF NOT EXISTS \`${this.tableName}\` (
          id CHAR(36) PRIMARY KEY,
          app_id VARCHAR(255) NOT NULL,
          table_name VARCHAR(255) NOT NULL,
          local_checksum VARCHAR(64),
          local_version VARCHAR(50),
          local_updated_at DATETIME,
          remote_checksum VARCHAR(64),
          remote_version VARCHAR(50),
          remote_updated_at DATETIME,
          sync_status VARCHAR(20) NOT NULL DEFAULT 'unknown',
          last_sync_at DATETIME,
          last_sync_direction VARCHAR(10),
          last_sync_by VARCHAR(255),
          base_checksum VARCHAR(64),
          conflict_details JSON,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY unique_app_table (app_id, table_name)
        )
      `;
    } else {
      sql = `
        CREATE TABLE IF NOT EXISTS "${this.tableName}" (
          id TEXT PRIMARY KEY,
          app_id TEXT NOT NULL,
          table_name TEXT NOT NULL,
          local_checksum TEXT,
          local_version TEXT,
          local_updated_at TEXT,
          remote_checksum TEXT,
          remote_version TEXT,
          remote_updated_at TEXT,
          sync_status TEXT NOT NULL DEFAULT 'unknown',
          last_sync_at TEXT,
          last_sync_direction TEXT,
          last_sync_by TEXT,
          base_checksum TEXT,
          conflict_details TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          UNIQUE(app_id, table_name)
        )
      `;
    }
    await this.driver.execute(sql);
    if (this.dialect.name === "postgresql") {
      await this.driver.execute(`
        CREATE INDEX IF NOT EXISTS idx_${this.tableName}_status
        ON "${this.tableName}"(app_id, sync_status)
      `).catch(() => {
      });
    }
  }
  async getSyncState(appId, tableName) {
    let sql;
    let params;
    if (this.dialect.name === "postgresql") {
      sql = `SELECT * FROM "${this.tableName}" WHERE app_id = $1 AND table_name = $2`;
      params = [appId, tableName];
    } else {
      sql = `SELECT * FROM ${this.dialect.name === "mysql" ? `\`${this.tableName}\`` : `"${this.tableName}"`} WHERE app_id = ? AND table_name = ?`;
      params = [appId, tableName];
    }
    const result = await this.driver.query(sql, params);
    if (!result.rows.length) return null;
    const row = result.rows[0];
    return {
      appId: row.app_id,
      tableName: row.table_name,
      localChecksum: row.local_checksum,
      localVersion: row.local_version,
      localUpdatedAt: row.local_updated_at ? new Date(row.local_updated_at) : null,
      remoteChecksum: row.remote_checksum,
      remoteVersion: row.remote_version,
      remoteUpdatedAt: row.remote_updated_at ? new Date(row.remote_updated_at) : null,
      syncStatus: row.sync_status,
      lastSyncAt: row.last_sync_at ? new Date(row.last_sync_at) : null,
      lastSyncDirection: row.last_sync_direction,
      lastSyncBy: row.last_sync_by,
      baseChecksum: row.base_checksum,
      conflictDetails: typeof row.conflict_details === "string" ? JSON.parse(row.conflict_details) : row.conflict_details
    };
  }
  async getAllSyncStates(appId) {
    let sql;
    let params;
    if (this.dialect.name === "postgresql") {
      sql = `SELECT * FROM "${this.tableName}" WHERE app_id = $1 ORDER BY table_name`;
      params = [appId];
    } else {
      sql = `SELECT * FROM ${this.dialect.name === "mysql" ? `\`${this.tableName}\`` : `"${this.tableName}"`} WHERE app_id = ? ORDER BY table_name`;
      params = [appId];
    }
    const result = await this.driver.query(sql, params);
    return result.rows.map((row) => ({
      appId: row.app_id,
      tableName: row.table_name,
      localChecksum: row.local_checksum,
      localVersion: row.local_version,
      localUpdatedAt: row.local_updated_at ? new Date(row.local_updated_at) : null,
      remoteChecksum: row.remote_checksum,
      remoteVersion: row.remote_version,
      remoteUpdatedAt: row.remote_updated_at ? new Date(row.remote_updated_at) : null,
      syncStatus: row.sync_status,
      lastSyncAt: row.last_sync_at ? new Date(row.last_sync_at) : null,
      lastSyncDirection: row.last_sync_direction,
      lastSyncBy: row.last_sync_by,
      baseChecksum: row.base_checksum,
      conflictDetails: typeof row.conflict_details === "string" ? JSON.parse(row.conflict_details) : row.conflict_details
    }));
  }
  async updateSyncState(appId, direction, data) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const status = "synced";
    if (this.dialect.name === "postgresql") {
      await this.driver.execute(
        `
        INSERT INTO "${this.tableName}" (
          app_id, table_name, local_checksum, local_version, local_updated_at,
          remote_checksum, remote_version, remote_updated_at, sync_status,
          last_sync_at, last_sync_direction, last_sync_by, base_checksum
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (app_id, table_name) DO UPDATE SET
          local_checksum = COALESCE($3, "${this.tableName}".local_checksum),
          local_version = COALESCE($4, "${this.tableName}".local_version),
          local_updated_at = $5,
          remote_checksum = COALESCE($6, "${this.tableName}".remote_checksum),
          remote_version = COALESCE($7, "${this.tableName}".remote_version),
          remote_updated_at = $8,
          sync_status = $9,
          last_sync_at = $10,
          last_sync_direction = $11,
          last_sync_by = $12,
          base_checksum = COALESCE($13, "${this.tableName}".base_checksum),
          updated_at = NOW()
        `,
        [
          appId,
          "__global__",
          data.localChecksum ?? null,
          data.localVersion ?? null,
          now,
          data.remoteChecksum ?? null,
          data.remoteVersion ?? null,
          now,
          status,
          now,
          direction,
          data.syncBy ?? null,
          data.localChecksum ?? data.remoteChecksum ?? null
        ]
      );
    } else if (this.dialect.name === "mysql") {
      const id = this.generateUUID();
      await this.driver.execute(
        `
        INSERT INTO \`${this.tableName}\` (
          id, app_id, table_name, local_checksum, local_version, local_updated_at,
          remote_checksum, remote_version, remote_updated_at, sync_status,
          last_sync_at, last_sync_direction, last_sync_by, base_checksum
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          local_checksum = COALESCE(VALUES(local_checksum), local_checksum),
          local_version = COALESCE(VALUES(local_version), local_version),
          local_updated_at = VALUES(local_updated_at),
          remote_checksum = COALESCE(VALUES(remote_checksum), remote_checksum),
          remote_version = COALESCE(VALUES(remote_version), remote_version),
          remote_updated_at = VALUES(remote_updated_at),
          sync_status = VALUES(sync_status),
          last_sync_at = VALUES(last_sync_at),
          last_sync_direction = VALUES(last_sync_direction),
          last_sync_by = VALUES(last_sync_by),
          base_checksum = COALESCE(VALUES(base_checksum), base_checksum)
        `,
        [
          id,
          appId,
          "__global__",
          data.localChecksum ?? null,
          data.localVersion ?? null,
          now,
          data.remoteChecksum ?? null,
          data.remoteVersion ?? null,
          now,
          status,
          now,
          direction,
          data.syncBy ?? null,
          data.localChecksum ?? data.remoteChecksum ?? null
        ]
      );
    } else {
      const id = this.generateUUID();
      await this.driver.execute(
        `
        INSERT OR REPLACE INTO "${this.tableName}" (
          id, app_id, table_name, local_checksum, local_version, local_updated_at,
          remote_checksum, remote_version, remote_updated_at, sync_status,
          last_sync_at, last_sync_direction, last_sync_by, base_checksum,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        `,
        [
          id,
          appId,
          "__global__",
          data.localChecksum ?? null,
          data.localVersion ?? null,
          now,
          data.remoteChecksum ?? null,
          data.remoteVersion ?? null,
          now,
          status,
          now,
          direction,
          data.syncBy ?? null,
          data.localChecksum ?? data.remoteChecksum ?? null
        ]
      );
    }
  }
  async markConflict(appId, tableName, conflictDetails) {
    const detailsJson = JSON.stringify(conflictDetails);
    if (this.dialect.name === "postgresql") {
      await this.driver.execute(
        `
        UPDATE "${this.tableName}"
        SET sync_status = 'conflict', conflict_details = $1, updated_at = NOW()
        WHERE app_id = $2 AND table_name = $3
        `,
        [detailsJson, appId, tableName]
      );
    } else {
      const table = this.dialect.name === "mysql" ? `\`${this.tableName}\`` : `"${this.tableName}"`;
      await this.driver.execute(
        `UPDATE ${table} SET sync_status = 'conflict', conflict_details = ? WHERE app_id = ? AND table_name = ?`,
        [detailsJson, appId, tableName]
      );
    }
  }
  async detectConflicts(appId) {
    const states = await this.getAllSyncStates(appId);
    return states.filter((state) => {
      if (!state.localChecksum || !state.remoteChecksum || !state.baseChecksum) {
        return false;
      }
      const localChanged = state.localChecksum !== state.baseChecksum;
      const remoteChanged = state.remoteChecksum !== state.baseChecksum;
      return localChanged && remoteChanged && state.localChecksum !== state.remoteChecksum;
    });
  }
  generateUUID() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === "x" ? r : r & 3 | 8;
      return v.toString(16);
    });
  }
};

// src/schema/sync.ts
var defaultLogger = {
  info: (msg) => console.log(msg),
  warn: (msg) => console.warn(msg),
  error: (msg) => console.error(msg)
};
var SchemaSyncService = class {
  constructor(driver, dialect, remoteClient, options, logger = defaultLogger) {
    this.driver = driver;
    this.dialect = dialect;
    this.remoteClient = remoteClient;
    this.options = options;
    this.logger = logger;
    this.introspector = new SchemaIntrospector(driver, dialect);
    this.diffEngine = new SchemaDiffEngine(dialect);
    this.syncMetadata = new SyncMetadataManager(driver, dialect);
  }
  introspector;
  diffEngine;
  syncMetadata;
  async pull(options = {}) {
    const environment = options.environment ?? "production";
    this.logger.info(`Fetching schema from ${environment}...`);
    await this.syncMetadata.ensureSyncTable();
    const remote = await this.remoteClient.fetchSchema(environment);
    this.logger.info("Introspecting local database...");
    const localIntrospection = await this.introspector.introspect();
    const localSchema = this.introspector.toSchemaDefinition(localIntrospection);
    const diff = this.diffEngine.computeDiff(localSchema, remote.schema, {
      generateMigration: true,
      migrationName: `sync_pull_${environment}`
    });
    if (!diff.hasDifferences) {
      this.logger.info("Local schema is up to date");
      return { applied: false, diff };
    }
    this.logger.info(this.diffEngine.formatDiff(diff, "text"));
    if (options.dryRun) {
      this.logger.info("(dry-run) No changes applied");
      return { applied: false, diff };
    }
    if (diff.breakingChanges.length > 0 && !options.force) {
      throw new BreakingChangeError(
        `Pull would make ${diff.breakingChanges.length} breaking change(s). Use --force to apply anyway.`,
        diff.breakingChanges
      );
    }
    await this.applyMigration(diff);
    const localChecksum = this.computeSchemaChecksum(localSchema);
    await this.syncMetadata.updateSyncState(this.options.appId, "pull", {
      localChecksum,
      localVersion: diff.migration?.version,
      remoteChecksum: remote.checksum,
      remoteVersion: remote.version
    });
    this.logger.info("\u2713 Schema updated successfully");
    return { applied: true, diff };
  }
  async push(options = {}) {
    const environment = options.environment ?? "production";
    this.logger.info("Introspecting local schema...");
    await this.syncMetadata.ensureSyncTable();
    const localIntrospection = await this.introspector.introspect();
    const localSchema = this.introspector.toSchemaDefinition(localIntrospection);
    this.logger.info(`Fetching remote schema from ${environment}...`);
    const remote = await this.remoteClient.fetchSchema(environment);
    const diff = this.diffEngine.computeDiff(remote.schema, localSchema, {
      generateMigration: true,
      migrationName: `sync_push_${environment}`
    });
    if (!diff.hasDifferences) {
      this.logger.info("Remote schema is up to date");
      return { applied: false, diff };
    }
    this.logger.info(this.diffEngine.formatDiff(diff, "text"));
    if (options.dryRun) {
      this.logger.info("(dry-run) No changes would be pushed");
      return { applied: false, diff };
    }
    if (environment === "production" && !options.force) {
      this.logger.warn("\u26A0\uFE0F  You are about to push schema changes to PRODUCTION");
      this.logger.warn("This operation cannot be automatically undone.");
      throw new UserCancelledError(
        "Production push requires --force flag. Review changes carefully before proceeding."
      );
    }
    if (diff.breakingChanges.length > 0 && !options.force) {
      throw new BreakingChangeError(
        `Push would make ${diff.breakingChanges.length} breaking change(s). Use --force to apply anyway.`,
        diff.breakingChanges
      );
    }
    if (!diff.migration) {
      return { applied: false, diff };
    }
    const remoteResult = await this.remoteClient.pushMigration(diff.migration, {
      environment,
      dryRun: false,
      force: options.force
    });
    if (remoteResult.success) {
      const localChecksum = this.computeSchemaChecksum(localSchema);
      await this.syncMetadata.updateSyncState(this.options.appId, "push", {
        localChecksum,
        localVersion: diff.migration.version,
        remoteChecksum: localChecksum,
        remoteVersion: diff.migration.version
      });
      this.logger.info("\u2713 Schema pushed successfully");
    } else {
      this.logger.error("\u2717 Push failed");
      if (remoteResult.errors) {
        for (const error of remoteResult.errors) {
          this.logger.error(`  - ${error}`);
        }
      }
    }
    return { applied: remoteResult.success, diff, remoteResult };
  }
  async diff(options = {}) {
    const environment = options.environment ?? "production";
    this.logger.info("Introspecting local schema...");
    const localIntrospection = await this.introspector.introspect();
    const localSchema = this.introspector.toSchemaDefinition(localIntrospection);
    this.logger.info(`Fetching remote schema from ${environment}...`);
    const remote = await this.remoteClient.fetchSchema(environment);
    const diff = this.diffEngine.computeDiff(localSchema, remote.schema, {
      generateMigration: true,
      migrationName: `diff_${environment}`
    });
    return diff;
  }
  async getSyncStatus() {
    await this.syncMetadata.ensureSyncTable();
    return this.syncMetadata.getSyncState(this.options.appId, "__global__");
  }
  async introspectLocal() {
    const introspection = await this.introspector.introspect();
    return this.introspector.toSchemaDefinition(introspection);
  }
  formatDiff(diff, format = "text") {
    return this.diffEngine.formatDiff(diff, format);
  }
  async applyMigration(diff) {
    if (!diff.migration) return;
    if (this.dialect.supportsTransactionalDDL) {
      await this.driver.transaction(async (trx) => {
        for (const sql of diff.migration.upSql) {
          await trx.execute(sql);
        }
      });
    } else {
      for (const sql of diff.migration.upSql) {
        await this.driver.execute(sql);
      }
    }
  }
  computeSchemaChecksum(schema) {
    const normalized = JSON.stringify(schema, Object.keys(schema).sort());
    return createHash4("sha256").update(normalized).digest("hex");
  }
};
function createSchemaSyncService(driver, dialect, remoteClient, options, logger) {
  return new SchemaSyncService(driver, dialect, remoteClient, options, logger);
}

// src/types/generator.ts
function pascalCase(str) {
  return str.split(/[-_]/).map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join("");
}
function camelCase(str) {
  const pascal = pascalCase(str);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}
function pgTypeToTs(type) {
  const map = {
    uuid: "string",
    string: "string",
    text: "string",
    integer: "number",
    bigint: "number",
    float: "number",
    decimal: "number",
    boolean: "boolean",
    datetime: "Date",
    date: "Date",
    time: "string",
    json: "Record<string, unknown>",
    binary: "Buffer"
  };
  return map[type] || "unknown";
}
function pgTypeToZod(type) {
  const map = {
    uuid: "z.string().uuid()",
    string: "z.string()",
    text: "z.string()",
    integer: "z.number().int()",
    bigint: "z.number().int()",
    float: "z.number()",
    decimal: "z.number()",
    boolean: "z.boolean()",
    datetime: "z.coerce.date()",
    date: "z.coerce.date()",
    time: "z.string()",
    json: "z.record(z.unknown())",
    binary: "z.instanceof(Buffer)"
  };
  return map[type] || "z.unknown()";
}
function isAutoGeneratedColumn(colName, col) {
  if (colName === "id" && col.default) return true;
  if (colName === "created_at" && col.default) return true;
  if (colName === "updated_at" && col.default) return true;
  return false;
}
function generateTypes(schemas, options = {}) {
  const {
    includeInsertTypes = true,
    includeUpdateTypes = true,
    omitTenantColumns = true,
    insertSuffix = "Insert",
    updateSuffix = "Update"
  } = options;
  const lines = [
    "// Auto-generated by @launchpad/db-engine",
    "// Do not edit this file manually",
    ""
  ];
  for (const [schemaName, schema] of schemas) {
    const namespace = pascalCase(schemaName);
    lines.push(`export namespace ${namespace} {`);
    for (const [tableName, table] of Object.entries(schema.tables)) {
      const typeName = pascalCase(tableName);
      lines.push(`  /** Row type for ${tableName} table */`);
      lines.push(`  export interface ${typeName} {`);
      for (const [colName, col] of Object.entries(table.columns)) {
        const tsType = pgTypeToTs(col.type);
        const nullable = col.nullable ? " | null" : "";
        lines.push(`    ${colName}: ${tsType}${nullable};`);
      }
      lines.push("  }");
      lines.push("");
      if (includeInsertTypes) {
        lines.push(`  /** Insert type for ${tableName} table (omits auto-generated fields) */`);
        lines.push(`  export interface ${typeName}${insertSuffix} {`);
        for (const [colName, col] of Object.entries(table.columns)) {
          if (isAutoGeneratedColumn(colName, col)) continue;
          if (omitTenantColumns && col.tenant) continue;
          const tsType = pgTypeToTs(col.type);
          const optional = col.nullable || col.default ? "?" : "";
          lines.push(`    ${colName}${optional}: ${tsType};`);
        }
        lines.push("  }");
        lines.push("");
      }
      if (includeUpdateTypes) {
        lines.push(`  /** Update type for ${tableName} table (all fields optional) */`);
        lines.push(`  export interface ${typeName}${updateSuffix} {`);
        for (const [colName, col] of Object.entries(table.columns)) {
          if (colName === "id") continue;
          if (colName === "created_at") continue;
          if (omitTenantColumns && col.tenant) continue;
          const tsType = pgTypeToTs(col.type);
          lines.push(`    ${colName}?: ${tsType} | null;`);
        }
        lines.push("  }");
        lines.push("");
      }
    }
    const tableNames = Object.keys(schema.tables).map((t) => `'${t}'`).join(" | ");
    lines.push(`  export type TableName = ${tableNames};`);
    lines.push("");
    lines.push("  export interface Tables {");
    for (const tableName of Object.keys(schema.tables)) {
      const typeName = pascalCase(tableName);
      lines.push(`    ${tableName}: ${typeName};`);
    }
    lines.push("  }");
    lines.push("}");
    lines.push("");
  }
  lines.push("export type AllSchemas = {");
  for (const schemaName of schemas.keys()) {
    const namespace = pascalCase(schemaName);
    lines.push(`  ${schemaName}: typeof ${namespace};`);
  }
  lines.push("};");
  return lines.join("\n");
}
function generateZodSchemas(schemas, options = {}) {
  const {
    includeInsertTypes = true,
    includeUpdateTypes = true,
    omitTenantColumns = true,
    insertSuffix = "Insert",
    updateSuffix = "Update"
  } = options;
  const lines = [
    "// Auto-generated by @launchpad/db-engine",
    "// Do not edit this file manually",
    "",
    "import { z } from 'zod';",
    ""
  ];
  for (const [schemaName, schema] of schemas) {
    const schemaPrefix = camelCase(schemaName);
    lines.push(`// ==================== ${pascalCase(schemaName)} Schema ====================`);
    lines.push("");
    for (const [tableName, table] of Object.entries(schema.tables)) {
      const typeName = pascalCase(tableName);
      lines.push(`/** Zod schema for ${tableName} row */`);
      lines.push(`export const ${schemaPrefix}${typeName}Schema = z.object({`);
      for (const [colName, col] of Object.entries(table.columns)) {
        let zodType = pgTypeToZod(col.type);
        if (col.nullable) {
          zodType += ".nullable()";
        }
        lines.push(`  ${colName}: ${zodType},`);
      }
      lines.push("});");
      lines.push("");
      if (includeInsertTypes) {
        lines.push(`/** Zod schema for ${tableName} insert (omits auto-generated fields) */`);
        lines.push(`export const ${schemaPrefix}${typeName}${insertSuffix}Schema = z.object({`);
        for (const [colName, col] of Object.entries(table.columns)) {
          if (isAutoGeneratedColumn(colName, col)) continue;
          if (omitTenantColumns && col.tenant) continue;
          let zodType = pgTypeToZod(col.type);
          if (col.nullable || col.default) {
            zodType += ".optional()";
          }
          lines.push(`  ${colName}: ${zodType},`);
        }
        lines.push("});");
        lines.push("");
      }
      if (includeUpdateTypes) {
        lines.push(`/** Zod schema for ${tableName} update (all fields optional) */`);
        lines.push(`export const ${schemaPrefix}${typeName}${updateSuffix}Schema = z.object({`);
        for (const [colName, col] of Object.entries(table.columns)) {
          if (colName === "id") continue;
          if (colName === "created_at") continue;
          if (omitTenantColumns && col.tenant) continue;
          let zodType = pgTypeToZod(col.type);
          zodType += ".nullable().optional()";
          lines.push(`  ${colName}: ${zodType},`);
        }
        lines.push("});");
        lines.push("");
      }
      lines.push("/** Inferred types from Zod schemas */");
      lines.push(`export type ${typeName} = z.infer<typeof ${schemaPrefix}${typeName}Schema>;`);
      if (includeInsertTypes) {
        lines.push(
          `export type ${typeName}${insertSuffix} = z.infer<typeof ${schemaPrefix}${typeName}${insertSuffix}Schema>;`
        );
      }
      if (includeUpdateTypes) {
        lines.push(
          `export type ${typeName}${updateSuffix} = z.infer<typeof ${schemaPrefix}${typeName}${updateSuffix}Schema>;`
        );
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

// src/cli/index.ts
async function runMigrations(config, options) {
  const driver = await createDriver({ connectionString: config.databaseUrl });
  const runner = new MigrationRunner(driver, { migrationsPath: config.migrationsPath });
  try {
    const results = options.direction === "up" ? await runner.up(options) : await runner.down(options);
    for (const result of results) {
      if (result.success) {
        console.log(`\u2713 ${result.version}__${result.name} (${result.duration}ms)`);
      } else {
        console.error(`\u2717 ${result.version}__${result.name}: ${result.error}`);
      }
    }
    if (results.length === 0) {
      console.log("No migrations to run");
    }
  } finally {
    await driver.close();
  }
}
async function getMigrationStatus(config, options) {
  const driver = await createDriver({ connectionString: config.databaseUrl });
  const runner = new MigrationRunner(driver, { migrationsPath: config.migrationsPath });
  try {
    const status = await runner.status(options);
    console.log("\n=== Migration Status ===\n");
    if (status.current !== null) {
      console.log(`Current version: ${status.current}`);
    } else {
      console.log("Current version: (none)");
    }
    console.log(`
Applied (${status.applied.length}):`);
    for (const m of status.applied) {
      console.log(`  \u2713 ${m.version}__${m.name} (${m.appliedAt.toISOString()})`);
    }
    console.log(`
Pending (${status.pending.length}):`);
    for (const m of status.pending) {
      console.log(`  \u25CB ${m.version}__${m.name}`);
    }
  } finally {
    await driver.close();
  }
}
async function verifyMigrations(config, options) {
  const driver = await createDriver({ connectionString: config.databaseUrl });
  const runner = new MigrationRunner(driver, { migrationsPath: config.migrationsPath });
  try {
    const result = await runner.verify(options);
    if (result.valid) {
      console.log("\u2713 All migrations are valid");
    } else {
      console.error("\u2717 Migration verification failed:");
      for (const issue of result.issues) {
        console.error(`  - ${issue}`);
      }
      process.exit(1);
    }
  } finally {
    await driver.close();
  }
}
async function createMigration(config, options) {
  const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const filename = `${timestamp}__${options.name}.sql`;
  const dirPath = options.scope === "template" && options.templateKey ? join4(config.migrationsPath, "templates", options.templateKey) : join4(config.migrationsPath, "core");
  await mkdir2(dirPath, { recursive: true });
  const filePath = join4(dirPath, filename);
  const content = `-- ${filename}
-- Created: ${(/* @__PURE__ */ new Date()).toISOString()}

-- up


-- down

`;
  await writeFile2(filePath, content, "utf-8");
  console.log(`Created migration: ${filePath}`);
}
async function generateTypesFromRegistry(config, options) {
  const driver = await createDriver({ connectionString: config.databaseUrl });
  const registry = new SchemaRegistry(driver);
  try {
    const schemas = await registry.listSchemas(options.appId);
    if (schemas.length === 0) {
      console.log("No schemas registered");
      return;
    }
    const schemaMap = /* @__PURE__ */ new Map();
    for (const record of schemas) {
      schemaMap.set(record.schema_name, record.schema);
    }
    const generatorOptions = {
      includeInsertTypes: options.includeInsertTypes ?? true,
      includeUpdateTypes: options.includeUpdateTypes ?? true,
      insertSuffix: options.insertSuffix,
      updateSuffix: options.updateSuffix
    };
    const types = generateTypes(schemaMap, generatorOptions);
    const outputPath = options.outputPath ?? config.typesOutputPath ?? "./generated/types.ts";
    await mkdir2(dirname2(outputPath), { recursive: true });
    await writeFile2(outputPath, types, "utf-8");
    console.log(`Generated types: ${outputPath}`);
    console.log(`  Schemas: ${Array.from(schemaMap.keys()).join(", ")}`);
    console.log(`  Insert types: ${generatorOptions.includeInsertTypes ? "yes" : "no"}${options.insertSuffix ? ` (suffix: ${options.insertSuffix})` : ""}`);
    console.log(`  Update types: ${generatorOptions.includeUpdateTypes ? "yes" : "no"}${options.updateSuffix ? ` (suffix: ${options.updateSuffix})` : ""}`);
    if (options.includeZodSchemas) {
      const zodSchemas = generateZodSchemas(schemaMap, generatorOptions);
      const zodOutputPath = outputPath.replace(/\.ts$/, ".zod.ts");
      await writeFile2(zodOutputPath, zodSchemas, "utf-8");
      console.log(`Generated Zod schemas: ${zodOutputPath}`);
    }
  } finally {
    await driver.close();
  }
}
async function watchAndGenerateTypes(config, options) {
  const { debounceMs = 500 } = options;
  const outputPath = options.outputPath ?? config.typesOutputPath ?? "./generated/types.ts";
  let isShuttingDown = false;
  let debounceTimer = null;
  let lastChecksum = null;
  let pollInterval = null;
  const shutdown = async (driver2) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log("\n\nShutting down watch mode...");
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    if (pollInterval) {
      clearInterval(pollInterval);
    }
    if (driver2) {
      await driver2.close();
    }
    console.log("Watch mode stopped.");
    process.exit(0);
  };
  const computeChecksum = (schemas) => {
    const content = JSON.stringify(
      Array.from(schemas.entries()).sort((a, b) => a[0].localeCompare(b[0]))
    );
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return hash.toString(16);
  };
  const regenerateTypes = async (registry2, reason) => {
    try {
      const schemas = await registry2.listSchemas(options.appId);
      if (schemas.length === 0) {
        console.log(`[${(/* @__PURE__ */ new Date()).toLocaleTimeString()}] No schemas registered`);
        return;
      }
      const schemaMap = /* @__PURE__ */ new Map();
      for (const record of schemas) {
        schemaMap.set(record.schema_name, record.schema);
      }
      const newChecksum = computeChecksum(schemaMap);
      if (newChecksum === lastChecksum) {
        return;
      }
      lastChecksum = newChecksum;
      const generatorOptions = {
        includeInsertTypes: options.includeInsertTypes ?? true,
        includeUpdateTypes: options.includeUpdateTypes ?? true,
        insertSuffix: options.insertSuffix,
        updateSuffix: options.updateSuffix
      };
      const types = generateTypes(schemaMap, generatorOptions);
      await mkdir2(dirname2(outputPath), { recursive: true });
      await writeFile2(outputPath, types, "utf-8");
      const schemaNames = Array.from(schemaMap.keys()).join(", ");
      console.log(
        `[${(/* @__PURE__ */ new Date()).toLocaleTimeString()}] ${reason} - Regenerated types (${schemaNames})`
      );
      if (options.includeZodSchemas) {
        const zodSchemas = generateZodSchemas(schemaMap, generatorOptions);
        const zodOutputPath = outputPath.replace(/\.ts$/, ".zod.ts");
        await writeFile2(zodOutputPath, zodSchemas, "utf-8");
        console.log(`[${(/* @__PURE__ */ new Date()).toLocaleTimeString()}] ${reason} - Regenerated Zod schemas`);
      }
    } catch (error) {
      console.error(
        `[${(/* @__PURE__ */ new Date()).toLocaleTimeString()}] Error regenerating types:`,
        error instanceof Error ? error.message : error
      );
    }
  };
  const driver = await createDriver({ connectionString: config.databaseUrl });
  const registry = new SchemaRegistry(driver);
  process.on("SIGINT", () => shutdown(driver));
  process.on("SIGTERM", () => shutdown(driver));
  console.log("Watching for schema changes...");
  console.log(`  Output: ${outputPath}`);
  console.log(`  Debounce: ${debounceMs}ms`);
  console.log("  Press Ctrl+C to stop\n");
  await regenerateTypes(registry, "Initial generation");
  const debouncedRegenerate = (reason) => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(async () => {
      await regenerateTypes(registry, reason);
    }, debounceMs);
  };
  pollInterval = setInterval(() => {
    if (!isShuttingDown) {
      debouncedRegenerate("Schema change detected");
    }
  }, 1e3);
  await new Promise(() => {
  });
}
async function registerSchema(config, options) {
  const driver = await createDriver({ connectionString: config.databaseUrl });
  const registry = new SchemaRegistry(driver);
  try {
    await readFile4(options.schemaPath, "utf-8");
    const schemaModule = await import(options.schemaPath);
    const schema = schemaModule.schema || schemaModule.default;
    if (!schema?.tables) {
      throw new Error("Invalid schema file. Must export a SchemaDefinition with tables property.");
    }
    const results = await registry.register({
      appId: options.appId,
      schemaName: options.schemaName,
      version: options.version,
      schema
    });
    if (results.length === 0) {
      console.log("Schema is up to date");
    } else {
      console.log(`Applied ${results.length} schema changes:`);
      for (const result of results) {
        if (result.success) {
          console.log(`  \u2713 ${result.name}`);
        } else {
          console.error(`  \u2717 ${result.name}: ${result.error}`);
        }
      }
    }
  } finally {
    await driver.close();
  }
}
async function listModules(config) {
  const driver = await createDriver({ connectionString: config.databaseUrl });
  const registry = new ModuleRegistry(driver);
  try {
    const modules = await registry.list();
    console.log("\n=== Registered Modules ===\n");
    if (modules.length === 0) {
      console.log("No modules registered");
      return;
    }
    for (const mod of modules) {
      console.log(`${mod.name} (v${mod.version})`);
      console.log(`  Display name: ${mod.displayName}`);
      if (mod.description) {
        console.log(`  Description: ${mod.description}`);
      }
      console.log(`  Migration prefix: ${mod.migrationPrefix}`);
      if (mod.dependencies?.length) {
        console.log(`  Dependencies: ${mod.dependencies.join(", ")}`);
      }
      console.log();
    }
  } finally {
    await driver.close();
  }
}
async function registerModule(config, options) {
  const driver = await createDriver({ connectionString: config.databaseUrl });
  const registry = new ModuleRegistry(driver);
  try {
    const module = {
      name: options.name,
      displayName: options.displayName,
      version: options.version,
      migrationPrefix: options.migrationPrefix,
      description: options.description,
      dependencies: options.dependencies
    };
    await registry.register(module);
    console.log(`\u2713 Registered module: ${options.name} (v${options.version})`);
  } finally {
    await driver.close();
  }
}
async function runModuleMigrations(config, options) {
  const driver = await createDriver({ connectionString: config.databaseUrl });
  const runner = new MigrationRunner(driver, { migrationsPath: config.migrationsPath });
  const collector = new MigrationCollector();
  try {
    const sources = await collector.discoverFromDirectory(options.modulesPath);
    if (sources.length === 0) {
      console.log("No module migrations found");
      return;
    }
    console.log(`Found ${sources.length} module(s):`);
    for (const source of sources) {
      console.log(`  - ${source.moduleName}`);
    }
    console.log();
    const migrations = await collector.collect(sources);
    if (migrations.length === 0) {
      console.log("No migrations to run");
      return;
    }
    await runner.ensureMigrationsTable();
    const direction = options.direction ?? "up";
    let migrationsToRun = migrations;
    if (options.steps) {
      migrationsToRun = direction === "up" ? migrations.slice(0, options.steps) : migrations.slice(-options.steps).reverse();
    }
    for (const migration of migrationsToRun) {
      if (options.dryRun) {
        console.log(
          `[DRY RUN] Would ${direction === "up" ? "apply" : "rollback"}: ${migration.version}__${migration.name} (module: ${migration.moduleName})`
        );
        continue;
      }
      const startTime = Date.now();
      try {
        const statements = direction === "up" ? migration.up : migration.down;
        for (const sql of statements) {
          await driver.execute(sql);
        }
        console.log(
          `\u2713 ${migration.version}__${migration.name} (module: ${migration.moduleName}) (${Date.now() - startTime}ms)`
        );
      } catch (error) {
        console.error(
          `\u2717 ${migration.version}__${migration.name} (module: ${migration.moduleName}): ${error instanceof Error ? error.message : error}`
        );
        break;
      }
    }
  } finally {
    await driver.close();
  }
}
async function pullSchema(config, options = {}) {
  const driver = await createDriver({ connectionString: config.databaseUrl });
  const dialect = getDialect(driver.dialect);
  const authHandler = createAuthHandler();
  let authToken;
  try {
    authToken = await authHandler.getToken();
  } catch (error) {
    console.error("Authentication required. Run `launchpad login` first.");
    await driver.close();
    process.exit(1);
  }
  const remoteClient = createSchemaRemoteClient({
    apiUrl: config.apiUrl,
    projectId: config.projectId,
    authToken
  });
  const syncService = createSchemaSyncService(driver, dialect, remoteClient, {
    appId: config.appId,
    migrationsPath: config.migrationsPath
  });
  try {
    const result = await syncService.pull({
      environment: options.environment,
      dryRun: options.dryRun,
      force: options.force
    });
    if (result.applied) {
      console.log(`
\u2713 Applied ${result.diff.changes.length} change(s)`);
    } else if (!result.diff.hasDifferences) {
      console.log("\n\u2713 Local schema is already up to date");
    }
  } catch (error) {
    if (error instanceof BreakingChangeError) {
      console.error(`
\u2717 ${error.message}`);
      console.error("\nBreaking changes detected:");
      for (const change of error.changes) {
        console.error(`  - ${change.description}`);
      }
      process.exit(1);
    }
    throw error;
  } finally {
    await driver.close();
  }
}
async function pushSchema(config, options = {}) {
  const driver = await createDriver({ connectionString: config.databaseUrl });
  const dialect = getDialect(driver.dialect);
  const authHandler = createAuthHandler();
  let authToken;
  try {
    authToken = await authHandler.getToken();
  } catch (error) {
    console.error("Authentication required. Run `launchpad login` first.");
    await driver.close();
    process.exit(1);
  }
  const remoteClient = createSchemaRemoteClient({
    apiUrl: config.apiUrl,
    projectId: config.projectId,
    authToken
  });
  const syncService = createSchemaSyncService(driver, dialect, remoteClient, {
    appId: config.appId,
    migrationsPath: config.migrationsPath
  });
  try {
    const result = await syncService.push({
      environment: options.environment,
      dryRun: options.dryRun,
      force: options.force
    });
    if (result.applied) {
      console.log(`
\u2713 Pushed ${result.diff.changes.length} change(s) to remote`);
    } else if (!result.diff.hasDifferences) {
      console.log("\n\u2713 Remote schema is already up to date");
    }
  } catch (error) {
    if (error instanceof BreakingChangeError) {
      console.error(`
\u2717 ${error.message}`);
      console.error("\nBreaking changes detected:");
      for (const change of error.changes) {
        console.error(`  - ${change.description}`);
      }
      process.exit(1);
    }
    if (error instanceof UserCancelledError) {
      console.error(`
${error.message}`);
      process.exit(1);
    }
    throw error;
  } finally {
    await driver.close();
  }
}
async function diffSchema(config, options = {}) {
  const driver = await createDriver({ connectionString: config.databaseUrl });
  const dialect = getDialect(driver.dialect);
  const authHandler = createAuthHandler();
  let authToken;
  try {
    authToken = await authHandler.getToken();
  } catch (error) {
    console.error("Authentication required. Run `launchpad login` first.");
    await driver.close();
    process.exit(1);
  }
  const remoteClient = createSchemaRemoteClient({
    apiUrl: config.apiUrl,
    projectId: config.projectId,
    authToken
  });
  const syncService = createSchemaSyncService(driver, dialect, remoteClient, {
    appId: config.appId,
    migrationsPath: config.migrationsPath
  });
  try {
    const diff = await syncService.diff({
      environment: options.environment
    });
    const output = syncService.formatDiff(diff, options.outputFormat ?? "text");
    console.log(output);
    if (diff.hasDifferences) {
      process.exit(1);
    }
  } finally {
    await driver.close();
  }
}
async function getSyncStatus(config) {
  const driver = await createDriver({ connectionString: config.databaseUrl });
  const dialect = getDialect(driver.dialect);
  const authHandler = createAuthHandler();
  let authToken;
  try {
    authToken = await authHandler.getToken();
  } catch (error) {
    console.error("Authentication required. Run `launchpad login` first.");
    await driver.close();
    process.exit(1);
  }
  const remoteClient = createSchemaRemoteClient({
    apiUrl: config.apiUrl,
    projectId: config.projectId,
    authToken
  });
  const syncService = createSchemaSyncService(driver, dialect, remoteClient, {
    appId: config.appId,
    migrationsPath: config.migrationsPath
  });
  try {
    const status = await syncService.getSyncStatus();
    if (!status) {
      console.log("No sync history found. Run `db pull` or `db push` to sync.");
      return;
    }
    console.log("\n=== Sync Status ===\n");
    console.log(`Status: ${status.syncStatus}`);
    console.log(`Last sync: ${status.lastSyncAt?.toISOString() ?? "Never"}`);
    console.log(`Direction: ${status.lastSyncDirection ?? "N/A"}`);
    console.log(`Local checksum: ${status.localChecksum ?? "N/A"}`);
    console.log(`Remote checksum: ${status.remoteChecksum ?? "N/A"}`);
    if (status.syncStatus === "conflict") {
      console.log("\n\u26A0\uFE0F  Conflict detected! Manual resolution required.");
    }
  } finally {
    await driver.close();
  }
}
export {
  createMigration,
  diffSchema,
  generateTypesFromRegistry,
  getMigrationStatus,
  getSyncStatus,
  listModules,
  pullSchema,
  pushSchema,
  registerModule,
  registerSchema,
  runMigrations,
  runModuleMigrations,
  verifyMigrations,
  watchAndGenerateTypes
};
//# sourceMappingURL=index.js.map