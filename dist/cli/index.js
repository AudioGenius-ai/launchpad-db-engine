var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

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
  const client = new MongoClient(config.connectionString, {
    maxPoolSize: config.max ?? 10,
    serverSelectionTimeoutMS: config.connectTimeout ?? 5e3,
    maxIdleTimeMS: config.idleTimeout ?? 3e4
  });
  await client.connect();
  const db = client.db(config.database);
  const tracker = new QueryTracker();
  let queryIdCounter = 0;
  let draining = false;
  const generateQueryId = () => `mongo-${++queryIdCounter}`;
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
      await client.close();
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
  const tracker = new QueryTracker();
  let queryIdCounter = 0;
  let draining = false;
  const generateQueryId = () => `mysql-${++queryIdCounter}`;
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
      await pool.end();
    }
  };
}
var init_mysql = __esm({
  "src/driver/mysql.ts"() {
    "use strict";
    init_query_tracker();
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
  const tracker = new QueryTracker();
  let queryIdCounter = 0;
  let draining = false;
  const generateQueryId = () => `sqlite-${++queryIdCounter}`;
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
      db.close();
    }
  };
}
var init_sqlite = __esm({
  "src/driver/sqlite.ts"() {
    "use strict";
    init_query_tracker();
  }
});

// src/cli/index.ts
import { mkdir, readFile as readFile3, writeFile } from "fs/promises";
import { dirname, join as join3 } from "path";

// src/driver/postgresql.ts
init_query_tracker();
import postgres from "postgres";
function createPostgresDriver(config) {
  const sql = postgres(config.connectionString, {
    max: config.max ?? 20,
    idle_timeout: config.idleTimeout ?? 30,
    connect_timeout: config.connectTimeout ?? 10,
    prepare: true
  });
  const tracker = new QueryTracker();
  let queryIdCounter = 0;
  let draining = false;
  const generateQueryId = () => `pg-${++queryIdCounter}`;
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
      await sql.end();
    }
  };
}

// src/driver/index.ts
init_mongodb();
init_query_tracker();
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

// src/migrations/runner.ts
import { createHash } from "crypto";
import { readFile, readdir } from "fs/promises";
import { join } from "path";

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

// src/types/generator.ts
function pascalCase(str) {
  return str.split(/[-_]/).map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join("");
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
function generateTypes(schemas, options = {}) {
  const {
    includeInsertTypes = true,
    includeUpdateTypes = true,
    omitTenantColumns = true
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
        lines.push(`  /** Insert type for ${tableName} table */`);
        lines.push(`  export interface ${typeName}Insert {`);
        for (const [colName, col] of Object.entries(table.columns)) {
          if (colName === "id" && col.default) continue;
          if (colName === "created_at" && col.default) continue;
          if (colName === "updated_at" && col.default) continue;
          if (omitTenantColumns && col.tenant) continue;
          const tsType = pgTypeToTs(col.type);
          const optional = col.nullable || col.default ? "?" : "";
          lines.push(`    ${colName}${optional}: ${tsType};`);
        }
        lines.push("  }");
        lines.push("");
      }
      if (includeUpdateTypes) {
        lines.push(`  /** Update type for ${tableName} table */`);
        lines.push(`  export interface ${typeName}Update {`);
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
  const dirPath = options.scope === "template" && options.templateKey ? join3(config.migrationsPath, "templates", options.templateKey) : join3(config.migrationsPath, "core");
  await mkdir(dirPath, { recursive: true });
  const filePath = join3(dirPath, filename);
  const content = `-- ${filename}
-- Created: ${(/* @__PURE__ */ new Date()).toISOString()}

-- up


-- down

`;
  await writeFile(filePath, content, "utf-8");
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
    const types = generateTypes(schemaMap);
    const outputPath = options.outputPath ?? config.typesOutputPath ?? "./generated/types.ts";
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, types, "utf-8");
    console.log(`Generated types: ${outputPath}`);
    console.log(`  Schemas: ${Array.from(schemaMap.keys()).join(", ")}`);
  } finally {
    await driver.close();
  }
}
async function registerSchema(config, options) {
  const driver = await createDriver({ connectionString: config.databaseUrl });
  const registry = new SchemaRegistry(driver);
  try {
    await readFile3(options.schemaPath, "utf-8");
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
export {
  createMigration,
  generateTypesFromRegistry,
  getMigrationStatus,
  listModules,
  registerModule,
  registerSchema,
  runMigrations,
  runModuleMigrations,
  verifyMigrations
};
//# sourceMappingURL=index.js.map