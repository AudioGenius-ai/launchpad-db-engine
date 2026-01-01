var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
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
function isRetryableError(error, customErrors = []) {
  const allErrors = [...DEFAULT_RETRYABLE_ERRORS, ...customErrors];
  if (error instanceof Error) {
    const errorCode = error.code;
    const errorMessage = error.message;
    return allErrors.some((code) => errorCode === code || errorMessage.includes(code));
  }
  return false;
}
async function withRetry(operation, config = {}) {
  const maxRetries = config.maxRetries ?? 3;
  const baseDelayMs = config.baseDelayMs ?? 100;
  const maxDelayMs = config.maxDelayMs ?? 5e3;
  const retryableErrors = config.retryableErrors ?? [];
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries || !isRetryableError(error, retryableErrors)) {
        throw error;
      }
      const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      const jitter = Math.random() * delay * 0.1;
      console.warn(
        `[db-engine] Connection error (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${Math.round(delay)}ms:`,
        lastError.message
      );
      await new Promise((resolve) => setTimeout(resolve, delay + jitter));
    }
  }
  throw lastError;
}
function createTimeoutPromise(timeoutMs) {
  return new Promise(
    (_, reject) => setTimeout(() => reject(new Error("Health check timeout")), timeoutMs)
  );
}
var DEFAULT_RETRYABLE_ERRORS;
var init_retry = __esm({
  "src/driver/retry.ts"() {
    "use strict";
    DEFAULT_RETRYABLE_ERRORS = [
      "ECONNREFUSED",
      "ETIMEDOUT",
      "ECONNRESET",
      "EPIPE",
      "ENOTCONN",
      "57P01",
      "57P02",
      "57P03",
      "PROTOCOL_CONNECTION_LOST",
      "ER_CON_COUNT_ERROR"
    ];
  }
});

// src/driver/postgresql.ts
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
var init_postgresql = __esm({
  "src/driver/postgresql.ts"() {
    "use strict";
    init_health();
    init_query_tracker();
    init_retry();
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

// src/driver/signal-handler.ts
function registerSignalHandlers(driver, options = {}) {
  const {
    timeout = 3e4,
    exitCodeSuccess = 0,
    exitCodeForced = 1,
    autoExit = true,
    onShutdownStart,
    onShutdownComplete
  } = options;
  let shuttingDown = false;
  const handleSignal = async (signal) => {
    if (shuttingDown) {
      console.log(`[db-engine] Already shutting down, ignoring ${signal}`);
      return;
    }
    shuttingDown = true;
    console.log(`[db-engine] Received ${signal}, starting graceful shutdown`);
    onShutdownStart?.();
    try {
      const result = await driver.drainAndClose({
        timeout,
        onProgress: (progress) => {
          console.log(
            `[db-engine] Shutdown progress: ${progress.phase} - ${progress.activeQueries} active, ${progress.completedQueries} completed`
          );
        }
      });
      onShutdownComplete?.(result);
      if (autoExit) {
        const exitCode = result.cancelledQueries > 0 ? exitCodeForced : exitCodeSuccess;
        process.exit(exitCode);
      }
    } catch (error) {
      console.error("[db-engine] Error during shutdown:", error);
      if (autoExit) {
        process.exit(1);
      }
    }
  };
  const sigterm = () => {
    handleSignal("SIGTERM");
  };
  const sigint = () => {
    handleSignal("SIGINT");
  };
  process.on("SIGTERM", sigterm);
  process.on("SIGINT", sigint);
  return () => {
    process.off("SIGTERM", sigterm);
    process.off("SIGINT", sigint);
  };
}
var init_signal_handler = __esm({
  "src/driver/signal-handler.ts"() {
    "use strict";
  }
});

// src/driver/pool-monitor.ts
function createPoolMonitor(getStats, config = {}) {
  const warningThreshold = config.warningThreshold ?? 0.8;
  const criticalThreshold = config.criticalThreshold ?? 0.95;
  const checkIntervalMs = config.checkIntervalMs ?? 1e4;
  let interval = null;
  let lastLevel = "normal";
  function checkPool() {
    const stats = getStats();
    if (stats.maxConnections === 0) return;
    const utilization = stats.activeConnections / stats.maxConnections;
    if (utilization >= criticalThreshold && lastLevel !== "critical") {
      lastLevel = "critical";
      console.error(
        `[db-engine] CRITICAL: Pool exhaustion imminent (${(utilization * 100).toFixed(1)}% utilized)`,
        stats
      );
      config.onCritical?.(stats);
    } else if (utilization >= warningThreshold && utilization < criticalThreshold && lastLevel === "normal") {
      lastLevel = "warning";
      console.warn(
        `[db-engine] WARNING: High pool utilization (${(utilization * 100).toFixed(1)}%)`,
        stats
      );
      config.onWarning?.(stats);
    } else if (utilization < warningThreshold && lastLevel !== "normal") {
      lastLevel = "normal";
      console.info(
        `[db-engine] Pool utilization returned to normal (${(utilization * 100).toFixed(1)}%)`
      );
      config.onRecovery?.(stats);
    }
  }
  return {
    start() {
      if (interval) return;
      interval = setInterval(checkPool, checkIntervalMs);
      checkPool();
    },
    stop() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    },
    getLastLevel() {
      return lastLevel;
    }
  };
}
var init_pool_monitor = __esm({
  "src/driver/pool-monitor.ts"() {
    "use strict";
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

// src/driver/index.ts
var driver_exports = {};
__export(driver_exports, {
  QueryTracker: () => QueryTracker,
  createDriver: () => createDriver,
  createHealthCheckResult: () => createHealthCheckResult,
  createMongoDriver: () => createMongoDriver,
  createPoolMonitor: () => createPoolMonitor,
  createTimeoutPromise: () => createTimeoutPromise,
  detectDialect: () => detectDialect,
  getDefaultHealthCheckConfig: () => getDefaultHealthCheckConfig,
  isMongoDriver: () => isMongoDriver,
  isRetryableError: () => isRetryableError,
  registerSignalHandlers: () => registerSignalHandlers,
  withRetry: () => withRetry
});
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
var init_driver = __esm({
  "src/driver/index.ts"() {
    "use strict";
    init_postgresql();
    init_mongodb();
    init_query_tracker();
    init_signal_handler();
    init_health();
    init_pool_monitor();
    init_retry();
  }
});

// src/compiler/mongo.ts
var DEFAULT_TENANT_COLUMNS, MongoCompiler;
var init_mongo = __esm({
  "src/compiler/mongo.ts"() {
    "use strict";
    DEFAULT_TENANT_COLUMNS = {
      appId: "app_id",
      organizationId: "organization_id"
    };
    MongoCompiler = class {
      injectTenant;
      tenantColumns;
      constructor(options = {}) {
        this.injectTenant = options.injectTenant ?? true;
        this.tenantColumns = options.tenantColumns ?? DEFAULT_TENANT_COLUMNS;
      }
      compile(ast, ctx) {
        if (this.injectTenant && !ctx) {
          throw new Error("Tenant context is required when tenant injection is enabled");
        }
        switch (ast.type) {
          case "select":
            return this.compileSelect(ast, ctx);
          case "insert":
            return this.compileInsert(ast, ctx);
          case "update":
            return this.compileUpdate(ast, ctx);
          case "delete":
            return this.compileDelete(ast, ctx);
          default:
            throw new Error(`Unsupported query type: ${ast.type}`);
        }
      }
      compileSelect(ast, ctx) {
        const hasJoins = ast.joins && ast.joins.length > 0;
        const hasGroupBy = ast.groupBy && ast.groupBy.columns.length > 0;
        const hasHaving = ast.having && ast.having.length > 0;
        if (hasJoins || hasGroupBy || hasHaving) {
          return this.compileSelectAggregate(ast, ctx);
        }
        return this.compileSelectFind(ast, ctx);
      }
      compileSelectFind(ast, ctx) {
        const filter = this.buildFilter(ast.where, ctx);
        const options = {};
        if (ast.columns && !ast.columns.includes("*")) {
          const hasCountColumn = ast.columns.some((c) => c.toLowerCase().startsWith("count("));
          if (hasCountColumn) {
            return {
              type: "countDocuments",
              collection: ast.table,
              filter
            };
          }
          options.projection = {};
          for (const col of ast.columns) {
            options.projection[col] = 1;
          }
        }
        if (ast.orderBy) {
          options.sort = {
            [ast.orderBy.column]: ast.orderBy.direction === "desc" ? -1 : 1
          };
        }
        if (ast.offset !== void 0) options.skip = ast.offset;
        if (ast.limit !== void 0) options.limit = ast.limit;
        return {
          type: "find",
          collection: ast.table,
          filter,
          options: Object.keys(options).length > 0 ? options : void 0
        };
      }
      compileSelectAggregate(ast, ctx) {
        const pipeline = [];
        const filter = this.buildFilter(ast.where, ctx);
        if (Object.keys(filter).length > 0) {
          pipeline.push({ $match: filter });
        }
        if (ast.joins) {
          for (const join5 of ast.joins) {
            const leftCol = join5.on.leftColumn.split(".").pop();
            const rightCol = join5.on.rightColumn.split(".").pop();
            pipeline.push({
              $lookup: {
                from: join5.table,
                localField: leftCol,
                foreignField: rightCol,
                as: join5.alias ?? join5.table
              }
            });
            if (join5.type === "INNER") {
              pipeline.push({ $unwind: `$${join5.alias ?? join5.table}` });
            } else if (join5.type === "LEFT") {
              pipeline.push({
                $unwind: {
                  path: `$${join5.alias ?? join5.table}`,
                  preserveNullAndEmptyArrays: true
                }
              });
            }
          }
        }
        if (ast.groupBy && ast.groupBy.columns.length > 0) {
          const groupId = ast.groupBy.columns.length === 1 ? `$${ast.groupBy.columns[0]}` : Object.fromEntries(ast.groupBy.columns.map((c) => [c, `$${c}`]));
          pipeline.push({ $group: { _id: groupId } });
        }
        if (ast.having && ast.having.length > 0) {
          const havingFilter = {};
          for (const h of ast.having) {
            havingFilter[h.column] = this.mapOperatorValue(h.op, h.value);
          }
          pipeline.push({ $match: havingFilter });
        }
        if (ast.orderBy) {
          pipeline.push({
            $sort: {
              [ast.orderBy.column]: ast.orderBy.direction === "desc" ? -1 : 1
            }
          });
        }
        if (ast.offset !== void 0) pipeline.push({ $skip: ast.offset });
        if (ast.limit !== void 0) pipeline.push({ $limit: ast.limit });
        if (ast.columns && !ast.columns.includes("*")) {
          const project = {};
          for (const col of ast.columns) {
            if (!col.toLowerCase().startsWith("count(")) {
              project[col] = 1;
            }
          }
          if (Object.keys(project).length > 0) {
            pipeline.push({ $project: project });
          }
        }
        return {
          type: "aggregate",
          collection: ast.table,
          pipeline
        };
      }
      compileInsert(ast, ctx) {
        if (ast.dataRows && ast.dataRows.length > 0) {
          const documents = ast.dataRows.map((row) => this.injectTenantData(row, ctx));
          return {
            type: "insertMany",
            collection: ast.table,
            documents
          };
        }
        const document = this.injectTenantData(ast.data ?? {}, ctx);
        return {
          type: "insertOne",
          collection: ast.table,
          document
        };
      }
      compileUpdate(ast, ctx) {
        const filter = this.buildFilter(ast.where, ctx);
        const update = { $set: ast.data };
        if (ast.returning && ast.returning.length > 0) {
          const projection = {};
          for (const col of ast.returning) {
            projection[col] = 1;
          }
          return {
            type: "findOneAndUpdate",
            collection: ast.table,
            filter,
            update,
            options: {
              returnDocument: "after",
              projection
            }
          };
        }
        return {
          type: "updateMany",
          collection: ast.table,
          filter,
          update
        };
      }
      compileDelete(ast, ctx) {
        const filter = this.buildFilter(ast.where, ctx);
        if (ast.returning && ast.returning.length > 0) {
          const projection = {};
          for (const col of ast.returning) {
            projection[col] = 1;
          }
          return {
            type: "findOneAndDelete",
            collection: ast.table,
            filter,
            options: {
              projection
            }
          };
        }
        return {
          type: "deleteMany",
          collection: ast.table,
          filter
        };
      }
      buildFilter(where, ctx) {
        const filter = {};
        if (this.injectTenant && ctx) {
          filter[this.tenantColumns.appId] = ctx.appId;
          filter[this.tenantColumns.organizationId] = ctx.organizationId;
        }
        if (where) {
          const orConditions = [];
          let hasOr = false;
          for (const clause of where) {
            const value = this.mapOperatorValue(clause.op, clause.value);
            if (clause.connector === "OR") {
              hasOr = true;
              orConditions.push({ [clause.column]: value });
            } else {
              if (filter[clause.column] !== void 0) {
                const existing = filter[clause.column];
                if (typeof existing === "object" && existing !== null && typeof value === "object" && value !== null) {
                  filter[clause.column] = {
                    ...existing,
                    ...value
                  };
                } else {
                  filter[clause.column] = value;
                }
              } else {
                filter[clause.column] = value;
              }
            }
          }
          if (hasOr) {
            const andConditions = [];
            for (const [key, val] of Object.entries(filter)) {
              if (key !== "$or") {
                andConditions.push({ [key]: val });
              }
            }
            if (orConditions.length > 0) {
              if (andConditions.length > 0) {
                return {
                  $and: [...andConditions, { $or: orConditions }]
                };
              }
              filter.$or = orConditions;
            }
          }
        }
        return filter;
      }
      mapOperatorValue(op, value) {
        switch (op) {
          case "=":
            return value;
          case "!=":
            return { $ne: value };
          case ">":
            return { $gt: value };
          case "<":
            return { $lt: value };
          case ">=":
            return { $gte: value };
          case "<=":
            return { $lte: value };
          case "IN":
            return { $in: value };
          case "NOT IN":
            return { $nin: value };
          case "LIKE":
            return { $regex: this.likeToRegex(value) };
          case "ILIKE":
            return { $regex: this.likeToRegex(value), $options: "i" };
          case "IS NULL":
            return null;
          case "IS NOT NULL":
            return { $ne: null };
          default:
            throw new Error(`Unsupported operator: ${op}`);
        }
      }
      likeToRegex(pattern) {
        return pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\%/g, "%").replace(/%/g, ".*").replace(/\\_/g, "_").replace(/_/g, ".");
      }
      injectTenantData(data, ctx) {
        if (!this.injectTenant || !ctx) return data;
        return {
          ...data,
          [this.tenantColumns.appId]: ctx.appId,
          [this.tenantColumns.organizationId]: ctx.organizationId
        };
      }
    };
  }
});

// src/compiler/index.ts
function createCompiler(options) {
  return new SQLCompiler(options);
}
var DEFAULT_TENANT_COLUMNS2, SQLCompiler;
var init_compiler = __esm({
  "src/compiler/index.ts"() {
    "use strict";
    init_mongo();
    DEFAULT_TENANT_COLUMNS2 = {
      appId: "app_id",
      organizationId: "organization_id"
    };
    SQLCompiler = class {
      dialect;
      injectTenant;
      tenantColumns;
      constructor(options) {
        this.dialect = options.dialect;
        this.injectTenant = options.injectTenant ?? true;
        this.tenantColumns = options.tenantColumns ?? DEFAULT_TENANT_COLUMNS2;
      }
      compile(ast, ctx) {
        switch (ast.type) {
          case "select":
            return this.compileSelect(ast, ctx);
          case "insert":
            return this.compileInsert(ast, ctx);
          case "update":
            return this.compileUpdate(ast, ctx);
          case "delete":
            return this.compileDelete(ast, ctx);
          default:
            throw new Error(`Unsupported query type: ${ast.type}`);
        }
      }
      getParamPlaceholder(index) {
        switch (this.dialect) {
          case "postgresql":
            return `$${index}`;
          case "mysql":
          case "sqlite":
            return "?";
          default:
            return `$${index}`;
        }
      }
      compileSelect(ast, ctx) {
        if (this.injectTenant && !ctx) {
          throw new Error("Tenant context is required when tenant injection is enabled");
        }
        const state = { params: [], paramIndex: 1 };
        let sql = this.compileSelectFrom(ast);
        sql += this.compileSelectJoins(ast);
        sql += this.compileSelectWhere(ast, ctx, state);
        sql += this.compileSelectGroupBy(ast);
        sql += this.compileSelectHaving(ast, state);
        sql += this.compileSelectOrderBy(ast);
        sql += this.compileSelectLimitOffset(ast);
        return { sql, params: state.params };
      }
      compileSelectFrom(ast) {
        const columns = ast.columns?.length ? ast.columns.map((c) => this.quoteIdentifier(c)).join(", ") : "*";
        return `SELECT ${columns} FROM ${this.quoteIdentifier(ast.table)}`;
      }
      compileSelectJoins(ast) {
        if (!ast.joins?.length) return "";
        return ast.joins.map((join5) => {
          const alias = join5.alias ? ` AS ${this.quoteIdentifier(join5.alias)}` : "";
          return ` ${join5.type} JOIN ${this.quoteIdentifier(join5.table)}${alias} ON ${this.quoteIdentifier(join5.on.leftColumn)} = ${this.quoteIdentifier(join5.on.rightColumn)}`;
        }).join("");
      }
      compileSelectWhere(ast, ctx, state) {
        const predicates = this.buildWherePredicates(ast, ctx, state);
        if (predicates.length === 0) return "";
        return ` WHERE ${this.joinPredicates(predicates, ast.where || [])}`;
      }
      buildWherePredicates(ast, ctx, state) {
        const predicates = [];
        if (this.injectTenant && ctx) {
          const tablePrefix = ast.joins?.length ? `${ast.table}.` : "";
          predicates.push(
            `${this.quoteIdentifier(`${tablePrefix}${this.tenantColumns.appId}`)} = ${this.getParamPlaceholder(state.paramIndex++)}`
          );
          state.params.push(ctx.appId);
          predicates.push(
            `${this.quoteIdentifier(`${tablePrefix}${this.tenantColumns.organizationId}`)} = ${this.getParamPlaceholder(state.paramIndex++)}`
          );
          state.params.push(ctx.organizationId);
        }
        if (ast.where?.length) {
          for (const w of ast.where) {
            const { predicate, values, paramCount } = this.compileWhere(w, state.paramIndex);
            predicates.push(predicate);
            state.params.push(...values);
            state.paramIndex += paramCount;
          }
        }
        return predicates;
      }
      compileSelectGroupBy(ast) {
        if (!ast.groupBy?.columns.length) return "";
        return ` GROUP BY ${ast.groupBy.columns.map((c) => this.quoteIdentifier(c)).join(", ")}`;
      }
      compileSelectHaving(ast, state) {
        if (!ast.having?.length) return "";
        const havingClauses = [];
        for (const h of ast.having) {
          const { predicate, values, paramCount } = this.compileHaving(h, state.paramIndex);
          havingClauses.push(predicate);
          state.params.push(...values);
          state.paramIndex += paramCount;
        }
        return ` HAVING ${havingClauses.join(" AND ")}`;
      }
      compileSelectOrderBy(ast) {
        if (!ast.orderBy) return "";
        const direction = ast.orderBy.direction.toUpperCase();
        if (direction !== "ASC" && direction !== "DESC") {
          throw new Error(
            `Invalid ORDER BY direction: ${ast.orderBy.direction}. Must be 'ASC' or 'DESC'.`
          );
        }
        return ` ORDER BY ${this.quoteIdentifier(ast.orderBy.column)} ${direction}`;
      }
      compileSelectLimitOffset(ast) {
        let sql = "";
        if (ast.limit !== void 0) {
          sql += ` LIMIT ${ast.limit}`;
        }
        if (ast.offset !== void 0) {
          sql += ` OFFSET ${ast.offset}`;
        }
        return sql;
      }
      compileInsert(ast, ctx) {
        if (this.injectTenant && !ctx) {
          throw new Error("Tenant context is required when tenant injection is enabled");
        }
        const params = [];
        let paramIndex = 1;
        if (ast.dataRows !== void 0) {
          return this.compileInsertMany(ast, ctx, params, paramIndex);
        }
        const data = { ...ast.data };
        if (this.injectTenant && ctx) {
          data[this.tenantColumns.appId] = ctx.appId;
          data[this.tenantColumns.organizationId] = ctx.organizationId;
        }
        const columns = Object.keys(data);
        const values = [];
        for (const col of columns) {
          values.push(this.getParamPlaceholder(paramIndex++));
          params.push(data[col]);
        }
        let sql = `INSERT INTO ${this.quoteIdentifier(ast.table)} (${columns.map((c) => this.quoteIdentifier(c)).join(", ")}) VALUES (${values.join(", ")})`;
        if (ast.onConflict) {
          sql += this.compileOnConflict(ast.onConflict, columns, paramIndex, params);
        }
        if (ast.returning?.length) {
          sql += this.compileReturning(ast.returning);
        }
        return { sql, params };
      }
      compileInsertMany(ast, ctx, params, startParamIndex) {
        const rows = ast.dataRows.map((row) => {
          const data = { ...row };
          if (this.injectTenant && ctx) {
            data[this.tenantColumns.appId] = ctx.appId;
            data[this.tenantColumns.organizationId] = ctx.organizationId;
          }
          return data;
        });
        if (rows.length === 0) {
          throw new Error("Cannot insert empty array of rows");
        }
        const columns = Object.keys(rows[0]);
        const valueGroups = [];
        let currentParamIndex = startParamIndex;
        for (const row of rows) {
          const values = [];
          for (const col of columns) {
            values.push(this.getParamPlaceholder(currentParamIndex++));
            params.push(row[col]);
          }
          valueGroups.push(`(${values.join(", ")})`);
        }
        let sql = `INSERT INTO ${this.quoteIdentifier(ast.table)} (${columns.map((c) => this.quoteIdentifier(c)).join(", ")}) VALUES ${valueGroups.join(", ")}`;
        if (ast.onConflict) {
          sql += this.compileOnConflict(ast.onConflict, columns, currentParamIndex, params);
        }
        if (ast.returning?.length) {
          sql += this.compileReturning(ast.returning);
        }
        return { sql, params };
      }
      compileOnConflict(conflict, columns, _paramIndex, _params) {
        if (!conflict) return "";
        const conflictCols = conflict.columns.map((c) => this.quoteIdentifier(c)).join(", ");
        switch (this.dialect) {
          case "postgresql":
          case "sqlite": {
            if (conflict.action === "nothing") {
              return ` ON CONFLICT (${conflictCols}) DO NOTHING`;
            }
            const updateCols = conflict.updateColumns || columns.filter((c) => !conflict.columns.includes(c));
            const setClauses = updateCols.map(
              (c) => `${this.quoteIdentifier(c)} = EXCLUDED.${this.quoteIdentifier(c)}`
            );
            return ` ON CONFLICT (${conflictCols}) DO UPDATE SET ${setClauses.join(", ")}`;
          }
          case "mysql": {
            if (conflict.action === "nothing") {
              return " ON DUPLICATE KEY UPDATE id = id";
            }
            const updateCols = conflict.updateColumns || columns.filter((c) => !conflict.columns.includes(c));
            const setClauses = updateCols.map(
              (c) => `${this.quoteIdentifier(c)} = VALUES(${this.quoteIdentifier(c)})`
            );
            return ` ON DUPLICATE KEY UPDATE ${setClauses.join(", ")}`;
          }
          default:
            throw new Error(`Unsupported dialect for ON CONFLICT: ${this.dialect}`);
        }
      }
      compileUpdate(ast, ctx) {
        if (this.injectTenant && !ctx) {
          throw new Error("Tenant context is required when tenant injection is enabled");
        }
        const params = [];
        let paramIndex = 1;
        const setClauses = [];
        for (const [key, value] of Object.entries(ast.data)) {
          setClauses.push(`${this.quoteIdentifier(key)} = ${this.getParamPlaceholder(paramIndex++)}`);
          params.push(value);
        }
        let sql = `UPDATE ${this.quoteIdentifier(ast.table)} SET ${setClauses.join(", ")}`;
        const predicates = [];
        if (this.injectTenant && ctx) {
          predicates.push(
            `${this.quoteIdentifier(this.tenantColumns.appId)} = ${this.getParamPlaceholder(paramIndex++)}`
          );
          params.push(ctx.appId);
          predicates.push(
            `${this.quoteIdentifier(this.tenantColumns.organizationId)} = ${this.getParamPlaceholder(paramIndex++)}`
          );
          params.push(ctx.organizationId);
        }
        if (ast.where?.length) {
          for (const w of ast.where) {
            const { predicate, values, paramCount } = this.compileWhere(w, paramIndex);
            predicates.push(predicate);
            params.push(...values);
            paramIndex += paramCount;
          }
        }
        if (predicates.length) {
          sql += ` WHERE ${predicates.join(" AND ")}`;
        }
        if (ast.returning?.length) {
          sql += this.compileReturning(ast.returning);
        }
        return { sql, params };
      }
      compileDelete(ast, ctx) {
        if (this.injectTenant && !ctx) {
          throw new Error("Tenant context is required when tenant injection is enabled");
        }
        const params = [];
        let paramIndex = 1;
        let sql = `DELETE FROM ${this.quoteIdentifier(ast.table)}`;
        const predicates = [];
        if (this.injectTenant && ctx) {
          predicates.push(
            `${this.quoteIdentifier(this.tenantColumns.appId)} = ${this.getParamPlaceholder(paramIndex++)}`
          );
          params.push(ctx.appId);
          predicates.push(
            `${this.quoteIdentifier(this.tenantColumns.organizationId)} = ${this.getParamPlaceholder(paramIndex++)}`
          );
          params.push(ctx.organizationId);
        }
        if (ast.where?.length) {
          for (const w of ast.where) {
            const { predicate, values, paramCount } = this.compileWhere(w, paramIndex);
            predicates.push(predicate);
            params.push(...values);
            paramIndex += paramCount;
          }
        }
        if (predicates.length) {
          sql += ` WHERE ${predicates.join(" AND ")}`;
        }
        if (ast.returning?.length) {
          sql += this.compileReturning(ast.returning);
        }
        return { sql, params };
      }
      compileReturning(columns) {
        switch (this.dialect) {
          case "postgresql":
          case "sqlite":
            return ` RETURNING ${columns.map((c) => this.quoteIdentifier(c)).join(", ")}`;
          case "mysql":
            throw new Error(
              "MySQL does not support RETURNING clause. Use separate SELECT query after INSERT/UPDATE/DELETE."
            );
          default:
            throw new Error(`Unsupported dialect for RETURNING: ${this.dialect}`);
        }
      }
      compileWhere(w, paramIndex) {
        const col = this.quoteIdentifier(w.column);
        switch (w.op) {
          case "IS NULL":
            return { predicate: `${col} IS NULL`, values: [], paramCount: 0 };
          case "IS NOT NULL":
            return { predicate: `${col} IS NOT NULL`, values: [], paramCount: 0 };
          case "IN":
          case "NOT IN": {
            const inValues = w.value;
            if (inValues.length === 0) {
              return {
                predicate: w.op === "IN" ? "1 = 0" : "1 = 1",
                values: [],
                paramCount: 0
              };
            }
            const placeholders = inValues.map((_, i) => this.getParamPlaceholder(paramIndex + i)).join(", ");
            return {
              predicate: `${col} ${w.op} (${placeholders})`,
              values: inValues,
              paramCount: inValues.length
            };
          }
          default:
            return {
              predicate: `${col} ${w.op} ${this.getParamPlaceholder(paramIndex)}`,
              values: w.value !== void 0 ? [w.value] : [],
              paramCount: w.value !== void 0 ? 1 : 0
            };
        }
      }
      joinPredicates(predicates, whereClauses) {
        if (predicates.length === 0) return "";
        const tenantPredicateCount = this.injectTenant ? 2 : 0;
        const result = predicates.map((predicate, i) => {
          if (i < tenantPredicateCount) return predicate;
          const clause = whereClauses[i - tenantPredicateCount];
          return clause?.connector === "OR" ? `OR ${predicate}` : predicate;
        });
        return result.reduce((sql, part, i) => {
          if (i === 0) return part;
          return part.startsWith("OR ") ? `${sql} ${part}` : `${sql} AND ${part}`;
        }, "");
      }
      compileHaving(h, paramIndex) {
        const col = this.quoteIdentifier(h.column);
        return {
          predicate: `${col} ${h.op} ${this.getParamPlaceholder(paramIndex)}`,
          values: [h.value],
          paramCount: 1
        };
      }
      quoteIdentifier(identifier) {
        if (identifier === "*") return identifier;
        if (identifier.includes("(") || identifier.toLowerCase().includes(" as ")) {
          return identifier;
        }
        if (identifier.includes(".")) {
          return identifier.split(".").map((part) => this.quoteIdentifier(part)).join(".");
        }
        switch (this.dialect) {
          case "postgresql":
            return `"${identifier}"`;
          case "mysql":
            return `\`${identifier}\``;
          case "sqlite":
            return `"${identifier}"`;
          default:
            return `"${identifier}"`;
        }
      }
    };
  }
});

// src/utils/tenant-validation.ts
function validateTenantContext(ctx, tableName) {
  if (!ctx) {
    throw new TenantContextError(
      `Missing tenant context for table "${tableName}". Provide a valid TenantContext with appId and organizationId, or use tableWithoutTenant() for system tables.`
    );
  }
  if (typeof ctx.appId !== "string" || ctx.appId.trim() === "") {
    throw new TenantContextError(
      `Invalid tenant context for table "${tableName}": appId must be a non-empty string.`
    );
  }
  if (typeof ctx.organizationId !== "string" || ctx.organizationId.trim() === "") {
    throw new TenantContextError(
      `Invalid tenant context for table "${tableName}": organizationId must be a non-empty string.`
    );
  }
}
function validateTenantContextOrWarn(ctx, tableName) {
  if (!ctx) {
    console.warn(
      `[WARNING] Missing tenant context for table "${tableName}". This query will not be filtered by tenant. Use tableWithoutTenant() explicitly if this is intended.`
    );
    return;
  }
  if (typeof ctx.appId !== "string" || ctx.appId.trim() === "") {
    console.warn(
      `[WARNING] Invalid appId in tenant context for table "${tableName}". This may result in unfiltered queries.`
    );
  }
  if (typeof ctx.organizationId !== "string" || ctx.organizationId.trim() === "") {
    console.warn(
      `[WARNING] Invalid organizationId in tenant context for table "${tableName}". This may result in unfiltered queries.`
    );
  }
}
var TenantContextError;
var init_tenant_validation = __esm({
  "src/utils/tenant-validation.ts"() {
    "use strict";
    TenantContextError = class extends Error {
      constructor(message) {
        super(message);
        this.name = "TenantContextError";
      }
    };
  }
});

// src/query-builder/index.ts
var SelectBuilder, InsertBuilder, UpdateBuilder, DeleteBuilder, TableBuilder, MongoSelectBuilder, MongoInsertBuilder, MongoUpdateBuilder, MongoDeleteBuilder, MongoTableBuilder;
var init_query_builder = __esm({
  "src/query-builder/index.ts"() {
    "use strict";
    init_tenant_validation();
    SelectBuilder = class {
      ast;
      driver;
      compiler;
      ctx;
      tenantValidated = false;
      shouldValidateTenant;
      constructor(driver, compiler, table, ctx, shouldValidateTenant = true) {
        this.driver = driver;
        this.compiler = compiler;
        this.ctx = ctx;
        this.shouldValidateTenant = shouldValidateTenant;
        this.ast = {
          type: "select",
          table,
          columns: ["*"],
          where: []
        };
      }
      validateTenantOnce() {
        if (!this.tenantValidated && this.shouldValidateTenant) {
          validateTenantContextOrWarn(this.ctx, this.ast.table);
          this.tenantValidated = true;
        }
      }
      select(...columns) {
        this.ast.columns = columns;
        return this;
      }
      where(column, op, value) {
        this.ast.where = this.ast.where ?? [];
        this.ast.where.push({ column, op, value });
        return this;
      }
      whereNull(column) {
        this.ast.where = this.ast.where ?? [];
        this.ast.where.push({ column, op: "IS NULL", value: null });
        return this;
      }
      whereNotNull(column) {
        this.ast.where = this.ast.where ?? [];
        this.ast.where.push({ column, op: "IS NOT NULL", value: null });
        return this;
      }
      whereIn(column, values) {
        this.ast.where = this.ast.where ?? [];
        this.ast.where.push({ column, op: "IN", value: values });
        return this;
      }
      whereNotIn(column, values) {
        this.ast.where = this.ast.where ?? [];
        this.ast.where.push({ column, op: "NOT IN", value: values });
        return this;
      }
      whereLike(column, pattern) {
        this.ast.where = this.ast.where ?? [];
        this.ast.where.push({ column, op: "LIKE", value: pattern });
        return this;
      }
      whereILike(column, pattern) {
        this.ast.where = this.ast.where ?? [];
        this.ast.where.push({ column, op: "ILIKE", value: pattern });
        return this;
      }
      orWhere(column, op, value) {
        this.ast.where = this.ast.where ?? [];
        this.ast.where.push({ column, op, value, connector: "OR" });
        return this;
      }
      groupBy(...columns) {
        this.ast.groupBy = { columns };
        return this;
      }
      having(column, op, value) {
        this.ast.having = this.ast.having ?? [];
        this.ast.having.push({ column, op, value });
        return this;
      }
      orderBy(column, direction = "asc") {
        this.ast.orderBy = { column, direction };
        return this;
      }
      limit(n) {
        this.ast.limit = n;
        return this;
      }
      offset(n) {
        this.ast.offset = n;
        return this;
      }
      join(type, table, leftColumn, rightColumn, alias) {
        this.ast.joins = this.ast.joins ?? [];
        this.ast.joins.push({
          type,
          table,
          alias,
          on: { leftColumn, rightColumn }
        });
        return this;
      }
      innerJoin(table, leftColumn, rightColumn, alias) {
        return this.join("INNER", table, leftColumn, rightColumn, alias);
      }
      leftJoin(table, leftColumn, rightColumn, alias) {
        return this.join("LEFT", table, leftColumn, rightColumn, alias);
      }
      async execute() {
        this.validateTenantOnce();
        const { sql, params } = this.compiler.compile(this.ast, this.ctx);
        const result = await this.driver.query(sql, params);
        return result.rows;
      }
      async first() {
        this.validateTenantOnce();
        this.limit(1);
        const rows = await this.execute();
        return rows[0] ?? null;
      }
      async count() {
        this.validateTenantOnce();
        const originalColumns = this.ast.columns;
        this.ast.columns = ["COUNT(*) as count"];
        const { sql, params } = this.compiler.compile(this.ast, this.ctx);
        const result = await this.driver.query(sql, params);
        this.ast.columns = originalColumns;
        return Number(result.rows[0]?.count ?? 0);
      }
      toSQL() {
        return this.compiler.compile(this.ast, this.ctx);
      }
    };
    InsertBuilder = class {
      ast;
      driver;
      compiler;
      ctx;
      tenantValidated = false;
      shouldValidateTenant;
      constructor(driver, compiler, table, ctx, shouldValidateTenant = true) {
        this.driver = driver;
        this.compiler = compiler;
        this.ctx = ctx;
        this.shouldValidateTenant = shouldValidateTenant;
        this.ast = {
          type: "insert",
          table,
          data: {}
        };
      }
      validateTenantOnce() {
        if (!this.tenantValidated && this.shouldValidateTenant) {
          validateTenantContextOrWarn(this.ctx, this.ast.table);
          this.tenantValidated = true;
        }
      }
      values(data) {
        this.ast.data = data;
        return this;
      }
      valuesMany(rows) {
        this.ast.dataRows = rows;
        return this;
      }
      onConflict(columns, action, updateColumns) {
        this.ast.onConflict = {
          columns,
          action,
          updateColumns
        };
        return this;
      }
      returning(...columns) {
        this.ast.returning = columns;
        return this;
      }
      async execute() {
        this.validateTenantOnce();
        const { sql, params } = this.compiler.compile(this.ast, this.ctx);
        if (this.ast.returning?.length) {
          const result = await this.driver.query(sql, params);
          return result.rows;
        }
        await this.driver.execute(sql, params);
        return [];
      }
      toSQL() {
        return this.compiler.compile(this.ast, this.ctx);
      }
    };
    UpdateBuilder = class {
      ast;
      driver;
      compiler;
      ctx;
      tenantValidated = false;
      shouldValidateTenant;
      constructor(driver, compiler, table, ctx, shouldValidateTenant = true) {
        this.driver = driver;
        this.compiler = compiler;
        this.ctx = ctx;
        this.shouldValidateTenant = shouldValidateTenant;
        this.ast = {
          type: "update",
          table,
          data: {},
          where: []
        };
      }
      validateTenantOnce() {
        if (!this.tenantValidated && this.shouldValidateTenant) {
          validateTenantContextOrWarn(this.ctx, this.ast.table);
          this.tenantValidated = true;
        }
      }
      set(data) {
        this.ast.data = data;
        return this;
      }
      where(column, op, value) {
        this.ast.where = this.ast.where ?? [];
        this.ast.where.push({ column, op, value });
        return this;
      }
      returning(...columns) {
        this.ast.returning = columns;
        return this;
      }
      async execute() {
        this.validateTenantOnce();
        const { sql, params } = this.compiler.compile(this.ast, this.ctx);
        if (this.ast.returning?.length) {
          const result = await this.driver.query(sql, params);
          return result.rows;
        }
        await this.driver.execute(sql, params);
        return [];
      }
      toSQL() {
        return this.compiler.compile(this.ast, this.ctx);
      }
    };
    DeleteBuilder = class {
      ast;
      driver;
      compiler;
      ctx;
      tenantValidated = false;
      shouldValidateTenant;
      constructor(driver, compiler, table, ctx, shouldValidateTenant = true) {
        this.driver = driver;
        this.compiler = compiler;
        this.ctx = ctx;
        this.shouldValidateTenant = shouldValidateTenant;
        this.ast = {
          type: "delete",
          table,
          where: []
        };
      }
      validateTenantOnce() {
        if (!this.tenantValidated && this.shouldValidateTenant) {
          validateTenantContextOrWarn(this.ctx, this.ast.table);
          this.tenantValidated = true;
        }
      }
      where(column, op, value) {
        this.ast.where = this.ast.where ?? [];
        this.ast.where.push({ column, op, value });
        return this;
      }
      returning(...columns) {
        this.ast.returning = columns;
        return this;
      }
      async execute() {
        this.validateTenantOnce();
        const { sql, params } = this.compiler.compile(this.ast, this.ctx);
        if (this.ast.returning?.length) {
          const result = await this.driver.query(sql, params);
          return result.rows;
        }
        await this.driver.execute(sql, params);
        return [];
      }
      toSQL() {
        return this.compiler.compile(this.ast, this.ctx);
      }
    };
    TableBuilder = class {
      driver;
      compiler;
      tableName;
      ctx;
      shouldValidateTenant;
      whereConditions = [];
      orderByClause;
      limitValue;
      offsetValue;
      constructor(driver, compiler, table, ctx, shouldValidateTenant = true) {
        this.driver = driver;
        this.compiler = compiler;
        this.tableName = table;
        this.ctx = ctx;
        this.shouldValidateTenant = shouldValidateTenant;
      }
      where(column, op, value) {
        this.whereConditions.push({ column, op, value });
        return this;
      }
      whereNull(column) {
        this.whereConditions.push({ column, op: "IS NULL", value: null });
        return this;
      }
      whereNotNull(column) {
        this.whereConditions.push({ column, op: "IS NOT NULL", value: null });
        return this;
      }
      whereIn(column, values) {
        this.whereConditions.push({ column, op: "IN", value: values });
        return this;
      }
      whereNotIn(column, values) {
        this.whereConditions.push({ column, op: "NOT IN", value: values });
        return this;
      }
      whereLike(column, pattern) {
        this.whereConditions.push({ column, op: "LIKE", value: pattern });
        return this;
      }
      whereILike(column, pattern) {
        this.whereConditions.push({ column, op: "ILIKE", value: pattern });
        return this;
      }
      orderBy(column, direction = "asc") {
        this.orderByClause = { column, direction };
        return this;
      }
      limit(n) {
        this.limitValue = n;
        return this;
      }
      offset(n) {
        this.offsetValue = n;
        return this;
      }
      select(...columns) {
        const builder = new SelectBuilder(
          this.driver,
          this.compiler,
          this.tableName,
          this.ctx,
          this.shouldValidateTenant
        );
        if (columns.length) {
          builder.select(...columns);
        }
        for (const w of this.whereConditions) {
          builder.where(w.column, w.op, w.value);
        }
        if (this.orderByClause) {
          builder.orderBy(this.orderByClause.column, this.orderByClause.direction);
        }
        if (this.limitValue !== void 0) {
          builder.limit(this.limitValue);
        }
        if (this.offsetValue !== void 0) {
          builder.offset(this.offsetValue);
        }
        return builder;
      }
      insert() {
        return new InsertBuilder(
          this.driver,
          this.compiler,
          this.tableName,
          this.ctx,
          this.shouldValidateTenant
        );
      }
      update(data) {
        const builder = new UpdateBuilder(
          this.driver,
          this.compiler,
          this.tableName,
          this.ctx,
          this.shouldValidateTenant
        );
        if (data) {
          builder.set(data);
        }
        for (const w of this.whereConditions) {
          builder.where(w.column, w.op, w.value);
        }
        return builder;
      }
      delete() {
        const builder = new DeleteBuilder(
          this.driver,
          this.compiler,
          this.tableName,
          this.ctx,
          this.shouldValidateTenant
        );
        for (const w of this.whereConditions) {
          builder.where(w.column, w.op, w.value);
        }
        return builder;
      }
      async findById(id) {
        return this.select().where("id", "=", id).first();
      }
      async findMany(options) {
        let builder = this.select();
        if (options?.where) {
          for (const w of options.where) {
            builder = builder.where(w.column, w.op, w.value);
          }
        }
        if (options?.orderBy) {
          builder = builder.orderBy(options.orderBy.column, options.orderBy.direction);
        }
        if (options?.limit !== void 0) {
          builder = builder.limit(options.limit);
        }
        if (options?.offset !== void 0) {
          builder = builder.offset(options.offset);
        }
        return builder.execute();
      }
    };
    MongoSelectBuilder = class {
      ast;
      driver;
      compiler;
      ctx;
      tenantValidated = false;
      shouldValidateTenant;
      constructor(driver, compiler, table, ctx, shouldValidateTenant = true) {
        this.driver = driver;
        this.compiler = compiler;
        this.ctx = ctx;
        this.shouldValidateTenant = shouldValidateTenant;
        this.ast = {
          type: "select",
          table,
          columns: ["*"],
          where: []
        };
      }
      validateTenantOnce() {
        if (!this.tenantValidated && this.shouldValidateTenant) {
          validateTenantContextOrWarn(this.ctx, this.ast.table);
          this.tenantValidated = true;
        }
      }
      select(...columns) {
        this.ast.columns = columns;
        return this;
      }
      where(column, op, value) {
        this.ast.where = this.ast.where ?? [];
        this.ast.where.push({ column, op, value });
        return this;
      }
      whereNull(column) {
        this.ast.where = this.ast.where ?? [];
        this.ast.where.push({ column, op: "IS NULL", value: null });
        return this;
      }
      whereNotNull(column) {
        this.ast.where = this.ast.where ?? [];
        this.ast.where.push({ column, op: "IS NOT NULL", value: null });
        return this;
      }
      whereIn(column, values) {
        this.ast.where = this.ast.where ?? [];
        this.ast.where.push({ column, op: "IN", value: values });
        return this;
      }
      whereNotIn(column, values) {
        this.ast.where = this.ast.where ?? [];
        this.ast.where.push({ column, op: "NOT IN", value: values });
        return this;
      }
      whereLike(column, pattern) {
        this.ast.where = this.ast.where ?? [];
        this.ast.where.push({ column, op: "LIKE", value: pattern });
        return this;
      }
      whereILike(column, pattern) {
        this.ast.where = this.ast.where ?? [];
        this.ast.where.push({ column, op: "ILIKE", value: pattern });
        return this;
      }
      orWhere(column, op, value) {
        this.ast.where = this.ast.where ?? [];
        this.ast.where.push({ column, op, value, connector: "OR" });
        return this;
      }
      groupBy(...columns) {
        this.ast.groupBy = { columns };
        return this;
      }
      having(column, op, value) {
        this.ast.having = this.ast.having ?? [];
        this.ast.having.push({ column, op, value });
        return this;
      }
      orderBy(column, direction = "asc") {
        this.ast.orderBy = { column, direction };
        return this;
      }
      limit(n) {
        this.ast.limit = n;
        return this;
      }
      offset(n) {
        this.ast.offset = n;
        return this;
      }
      join(type, table, leftColumn, rightColumn, alias) {
        this.ast.joins = this.ast.joins ?? [];
        this.ast.joins.push({
          type,
          table,
          alias,
          on: { leftColumn, rightColumn }
        });
        return this;
      }
      innerJoin(table, leftColumn, rightColumn, alias) {
        return this.join("INNER", table, leftColumn, rightColumn, alias);
      }
      leftJoin(table, leftColumn, rightColumn, alias) {
        return this.join("LEFT", table, leftColumn, rightColumn, alias);
      }
      async execute() {
        this.validateTenantOnce();
        const operation = this.compiler.compile(this.ast, this.ctx);
        const result = await this.driver.executeOperation(operation);
        return result.rows;
      }
      async first() {
        this.validateTenantOnce();
        this.limit(1);
        const rows = await this.execute();
        return rows[0] ?? null;
      }
      async count() {
        this.validateTenantOnce();
        const originalColumns = this.ast.columns;
        this.ast.columns = ["COUNT(*) as count"];
        const operation = this.compiler.compile(this.ast, this.ctx);
        const result = await this.driver.executeOperation(operation);
        this.ast.columns = originalColumns;
        return Number(result.rows[0]?.count ?? 0);
      }
      toOperation() {
        return this.compiler.compile(this.ast, this.ctx);
      }
    };
    MongoInsertBuilder = class {
      ast;
      driver;
      compiler;
      ctx;
      tenantValidated = false;
      shouldValidateTenant;
      constructor(driver, compiler, table, ctx, shouldValidateTenant = true) {
        this.driver = driver;
        this.compiler = compiler;
        this.ctx = ctx;
        this.shouldValidateTenant = shouldValidateTenant;
        this.ast = {
          type: "insert",
          table,
          data: {}
        };
      }
      validateTenantOnce() {
        if (!this.tenantValidated && this.shouldValidateTenant) {
          validateTenantContextOrWarn(this.ctx, this.ast.table);
          this.tenantValidated = true;
        }
      }
      values(data) {
        this.ast.data = data;
        return this;
      }
      valuesMany(rows) {
        this.ast.dataRows = rows;
        return this;
      }
      returning(...columns) {
        this.ast.returning = columns;
        return this;
      }
      async execute() {
        this.validateTenantOnce();
        const operation = this.compiler.compile(this.ast, this.ctx);
        const result = await this.driver.executeOperation(operation);
        return result.rows;
      }
      toOperation() {
        return this.compiler.compile(this.ast, this.ctx);
      }
    };
    MongoUpdateBuilder = class {
      ast;
      driver;
      compiler;
      ctx;
      tenantValidated = false;
      shouldValidateTenant;
      constructor(driver, compiler, table, ctx, shouldValidateTenant = true) {
        this.driver = driver;
        this.compiler = compiler;
        this.ctx = ctx;
        this.shouldValidateTenant = shouldValidateTenant;
        this.ast = {
          type: "update",
          table,
          data: {},
          where: []
        };
      }
      validateTenantOnce() {
        if (!this.tenantValidated && this.shouldValidateTenant) {
          validateTenantContextOrWarn(this.ctx, this.ast.table);
          this.tenantValidated = true;
        }
      }
      set(data) {
        this.ast.data = data;
        return this;
      }
      where(column, op, value) {
        this.ast.where = this.ast.where ?? [];
        this.ast.where.push({ column, op, value });
        return this;
      }
      returning(...columns) {
        this.ast.returning = columns;
        return this;
      }
      async execute() {
        this.validateTenantOnce();
        const operation = this.compiler.compile(this.ast, this.ctx);
        const result = await this.driver.executeOperation(operation);
        return result.rows;
      }
      toOperation() {
        return this.compiler.compile(this.ast, this.ctx);
      }
    };
    MongoDeleteBuilder = class {
      ast;
      driver;
      compiler;
      ctx;
      tenantValidated = false;
      shouldValidateTenant;
      constructor(driver, compiler, table, ctx, shouldValidateTenant = true) {
        this.driver = driver;
        this.compiler = compiler;
        this.ctx = ctx;
        this.shouldValidateTenant = shouldValidateTenant;
        this.ast = {
          type: "delete",
          table,
          where: []
        };
      }
      validateTenantOnce() {
        if (!this.tenantValidated && this.shouldValidateTenant) {
          validateTenantContextOrWarn(this.ctx, this.ast.table);
          this.tenantValidated = true;
        }
      }
      where(column, op, value) {
        this.ast.where = this.ast.where ?? [];
        this.ast.where.push({ column, op, value });
        return this;
      }
      returning(...columns) {
        this.ast.returning = columns;
        return this;
      }
      async execute() {
        this.validateTenantOnce();
        const operation = this.compiler.compile(this.ast, this.ctx);
        const result = await this.driver.executeOperation(operation);
        return result.rows;
      }
      toOperation() {
        return this.compiler.compile(this.ast, this.ctx);
      }
    };
    MongoTableBuilder = class {
      driver;
      compiler;
      tableName;
      ctx;
      shouldValidateTenant;
      whereConditions = [];
      orderByClause;
      limitValue;
      offsetValue;
      constructor(driver, compiler, table, ctx, shouldValidateTenant = true) {
        this.driver = driver;
        this.compiler = compiler;
        this.tableName = table;
        this.ctx = ctx;
        this.shouldValidateTenant = shouldValidateTenant;
      }
      where(column, op, value) {
        this.whereConditions.push({ column, op, value });
        return this;
      }
      whereNull(column) {
        this.whereConditions.push({ column, op: "IS NULL", value: null });
        return this;
      }
      whereNotNull(column) {
        this.whereConditions.push({ column, op: "IS NOT NULL", value: null });
        return this;
      }
      whereIn(column, values) {
        this.whereConditions.push({ column, op: "IN", value: values });
        return this;
      }
      whereNotIn(column, values) {
        this.whereConditions.push({ column, op: "NOT IN", value: values });
        return this;
      }
      whereLike(column, pattern) {
        this.whereConditions.push({ column, op: "LIKE", value: pattern });
        return this;
      }
      whereILike(column, pattern) {
        this.whereConditions.push({ column, op: "ILIKE", value: pattern });
        return this;
      }
      orderBy(column, direction = "asc") {
        this.orderByClause = { column, direction };
        return this;
      }
      limit(n) {
        this.limitValue = n;
        return this;
      }
      offset(n) {
        this.offsetValue = n;
        return this;
      }
      select(...columns) {
        const builder = new MongoSelectBuilder(
          this.driver,
          this.compiler,
          this.tableName,
          this.ctx,
          this.shouldValidateTenant
        );
        if (columns.length) {
          builder.select(...columns);
        }
        for (const w of this.whereConditions) {
          builder.where(w.column, w.op, w.value);
        }
        if (this.orderByClause) {
          builder.orderBy(this.orderByClause.column, this.orderByClause.direction);
        }
        if (this.limitValue !== void 0) {
          builder.limit(this.limitValue);
        }
        if (this.offsetValue !== void 0) {
          builder.offset(this.offsetValue);
        }
        return builder;
      }
      insert() {
        return new MongoInsertBuilder(
          this.driver,
          this.compiler,
          this.tableName,
          this.ctx,
          this.shouldValidateTenant
        );
      }
      update(data) {
        const builder = new MongoUpdateBuilder(
          this.driver,
          this.compiler,
          this.tableName,
          this.ctx,
          this.shouldValidateTenant
        );
        if (data) {
          builder.set(data);
        }
        for (const w of this.whereConditions) {
          builder.where(w.column, w.op, w.value);
        }
        return builder;
      }
      delete() {
        const builder = new MongoDeleteBuilder(
          this.driver,
          this.compiler,
          this.tableName,
          this.ctx,
          this.shouldValidateTenant
        );
        for (const w of this.whereConditions) {
          builder.where(w.column, w.op, w.value);
        }
        return builder;
      }
      async findById(id) {
        return this.select().where("id", "=", id).first();
      }
      async findMany(options) {
        let builder = this.select();
        if (options?.where) {
          for (const w of options.where) {
            builder = builder.where(w.column, w.op, w.value);
          }
        }
        if (options?.orderBy) {
          builder = builder.orderBy(options.orderBy.column, options.orderBy.direction);
        }
        if (options?.limit !== void 0) {
          builder = builder.limit(options.limit);
        }
        if (options?.offset !== void 0) {
          builder = builder.offset(options.offset);
        }
        return builder.execute();
      }
    };
  }
});

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
var mysqlDialect;
var init_mysql2 = __esm({
  "src/migrations/dialects/mysql.ts"() {
    "use strict";
    mysqlDialect = {
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
  }
});

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
var postgresDialect;
var init_postgresql2 = __esm({
  "src/migrations/dialects/postgresql.ts"() {
    "use strict";
    postgresDialect = {
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
  }
});

// src/migrations/dialects/sqlite.ts
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
var SQLITE_UUID_DEFAULT, sqliteDialect;
var init_sqlite2 = __esm({
  "src/migrations/dialects/sqlite.ts"() {
    "use strict";
    SQLITE_UUID_DEFAULT = "(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))))";
    sqliteDialect = {
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
  }
});

// src/migrations/dialects/mongodb.ts
var init_mongodb2 = __esm({
  "src/migrations/dialects/mongodb.ts"() {
    "use strict";
  }
});

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
var init_dialects = __esm({
  "src/migrations/dialects/index.ts"() {
    "use strict";
    init_mysql2();
    init_postgresql2();
    init_sqlite2();
    init_mongodb2();
  }
});

// src/migrations/runner.ts
import { createHash } from "crypto";
import { readFile, readdir } from "fs/promises";
import { join } from "path";
function createMigrationRunner(driver, options) {
  return new MigrationRunner(driver, options);
}
var MigrationRunner;
var init_runner = __esm({
  "src/migrations/runner.ts"() {
    "use strict";
    init_dialects();
    MigrationRunner = class {
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
  }
});

// src/schema/registry.ts
import { createHash as createHash2 } from "crypto";
function createSchemaRegistry(driver, options) {
  return new SchemaRegistry(driver, options);
}
var SchemaRegistry;
var init_registry = __esm({
  "src/schema/registry.ts"() {
    "use strict";
    init_dialects();
    SchemaRegistry = class {
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
  }
});

// src/client.ts
var client_exports = {};
__export(client_exports, {
  DbClient: () => DbClient,
  TransactionContext: () => TransactionContext,
  createDbClient: () => createDbClient
});
function createDbClient(driver, options) {
  return new DbClient(driver, options);
}
var DbClient, TransactionContext;
var init_client = __esm({
  "src/client.ts"() {
    "use strict";
    init_compiler();
    init_mongodb();
    init_runner();
    init_query_builder();
    init_registry();
    init_tenant_validation();
    DbClient = class {
      driver;
      compiler;
      migrationRunner;
      schemaRegistry;
      strictTenantMode;
      constructor(driver, options = {}) {
        this.driver = driver;
        if (driver.dialect === "mongodb") {
          this.compiler = new MongoCompiler({
            injectTenant: true,
            tenantColumns: options.tenantColumns
          });
        } else {
          this.compiler = new SQLCompiler({
            dialect: driver.dialect,
            injectTenant: true,
            tenantColumns: options.tenantColumns
          });
        }
        if (options.migrationsPath && driver.dialect !== "mongodb") {
          this.migrationRunner = new MigrationRunner(driver, {
            migrationsPath: options.migrationsPath
          });
        }
        this.schemaRegistry = new SchemaRegistry(driver);
        this.strictTenantMode = options.strictTenantMode ?? true;
      }
      table(name, ctx) {
        if (this.strictTenantMode) {
          validateTenantContext(ctx, name);
        }
        if (isMongoDriver(this.driver)) {
          return new MongoTableBuilder(this.driver, this.compiler, name, ctx, true);
        }
        return new TableBuilder(this.driver, this.compiler, name, ctx, true);
      }
      tableWithoutTenant(name) {
        if (isMongoDriver(this.driver)) {
          const compilerWithoutTenant2 = new MongoCompiler({ injectTenant: false });
          return new MongoTableBuilder(this.driver, compilerWithoutTenant2, name, void 0, false);
        }
        const compilerWithoutTenant = new SQLCompiler({
          dialect: this.driver.dialect,
          injectTenant: false
        });
        return new TableBuilder(this.driver, compilerWithoutTenant, name, void 0, false);
      }
      async transaction(ctx, fn) {
        return this.driver.transaction(async (trxClient) => {
          if (this.driver.dialect === "postgresql") {
            await trxClient.execute(`SELECT set_config('app.current_app_id', $1, true)`, [ctx.appId]);
            await trxClient.execute(`SELECT set_config('app.current_org_id', $1, true)`, [
              ctx.organizationId
            ]);
          }
          const trxContext = new TransactionContext(trxClient, this.compiler, ctx);
          return fn(trxContext);
        });
      }
      async raw(sql, params) {
        return this.driver.query(sql, params);
      }
      async rawWithTenant(ctx, sql, params = []) {
        const tenantParams = [ctx.appId, ctx.organizationId, ...params];
        return this.driver.query(sql, tenantParams);
      }
      async execute(sql, params) {
        return this.driver.execute(sql, params);
      }
      get migrations() {
        if (!this.migrationRunner) {
          throw new Error("Migrations path not configured. Pass migrationsPath to DbClient options.");
        }
        return {
          up: (options) => this.migrationRunner.up(options),
          down: (options) => this.migrationRunner.down(options),
          status: (options) => this.migrationRunner.status(options),
          verify: (options) => this.migrationRunner.verify(options)
        };
      }
      get schema() {
        return {
          register: (options) => this.schemaRegistry.register(options),
          get: (appId, schemaName) => this.schemaRegistry.getCurrentSchema(appId, schemaName),
          list: (appId) => this.schemaRegistry.listSchemas(appId)
        };
      }
      get dialect() {
        return this.driver.dialect;
      }
      async close() {
        return this.driver.close();
      }
    };
    TransactionContext = class {
      client;
      compiler;
      ctx;
      constructor(client, compiler, ctx) {
        this.client = client;
        this.compiler = compiler;
        this.ctx = ctx;
      }
      table(name) {
        return new TableBuilder(this.client, this.compiler, name, this.ctx, true);
      }
      async raw(sql, params) {
        return this.client.query(sql, params);
      }
      async execute(sql, params) {
        return this.client.execute(sql, params);
      }
    };
  }
});

// src/orm/metadata.ts
var MetadataStorage = class {
  entities = /* @__PURE__ */ new Map();
  registerEntity(target, tableName) {
    if (!this.entities.has(target)) {
      this.entities.set(target, {
        tableName,
        columns: /* @__PURE__ */ new Map(),
        indexes: [],
        relations: /* @__PURE__ */ new Map()
      });
    } else {
      const metadata = this.entities.get(target);
      metadata.tableName = tableName;
    }
  }
  registerColumn(target, propertyName, metadata) {
    this.ensureEntity(target);
    const entity = this.entities.get(target);
    const existing = entity.columns.get(propertyName) || {
      propertyName,
      columnName: this.toSnakeCase(propertyName),
      type: "string",
      primaryKey: false,
      nullable: true,
      unique: false,
      tenant: false
    };
    entity.columns.set(propertyName, { ...existing, ...metadata });
  }
  registerRelation(target, propertyName, metadata) {
    this.ensureEntity(target);
    const entity = this.entities.get(target);
    entity.relations.set(propertyName, metadata);
  }
  registerIndex(target, index) {
    this.ensureEntity(target);
    const entity = this.entities.get(target);
    entity.indexes.push(index);
  }
  getEntityMetadata(target) {
    return this.entities.get(target);
  }
  getAllEntities() {
    return this.entities;
  }
  hasEntity(target) {
    return this.entities.has(target);
  }
  ensureEntity(target) {
    if (!this.entities.has(target)) {
      this.entities.set(target, {
        tableName: this.toSnakeCase(target.name),
        columns: /* @__PURE__ */ new Map(),
        indexes: [],
        relations: /* @__PURE__ */ new Map()
      });
    }
  }
  toSnakeCase(str) {
    return str.replace(/([A-Z])/g, "_$1").toLowerCase().replace(/^_/, "");
  }
  clear() {
    this.entities.clear();
  }
};
var metadataStorage = new MetadataStorage();

// src/orm/decorators.ts
function Entity(tableNameOrOptions) {
  return (target) => {
    const tableName = typeof tableNameOrOptions === "string" ? tableNameOrOptions : tableNameOrOptions?.name || toSnakeCase(target.name);
    metadataStorage.registerEntity(target, tableName);
  };
}
function Column(type, options) {
  return (target, propertyKey) => {
    const propertyName = String(propertyKey);
    metadataStorage.registerColumn(target.constructor, propertyName, {
      propertyName,
      columnName: options?.name || toSnakeCase(propertyName),
      type,
      nullable: options?.nullable ?? true,
      unique: options?.unique ?? false,
      default: options?.default,
      references: options?.references,
      primaryKey: false,
      tenant: false
    });
  };
}
function PrimaryKey() {
  return (target, propertyKey) => {
    const propertyName = String(propertyKey);
    metadataStorage.registerColumn(target.constructor, propertyName, {
      primaryKey: true,
      nullable: false
    });
  };
}
function TenantColumn() {
  return (target, propertyKey) => {
    const propertyName = String(propertyKey);
    metadataStorage.registerColumn(target.constructor, propertyName, {
      tenant: true,
      nullable: false
    });
  };
}
function Unique() {
  return (target, propertyKey) => {
    const propertyName = String(propertyKey);
    metadataStorage.registerColumn(target.constructor, propertyName, {
      unique: true
    });
  };
}
function Nullable() {
  return (target, propertyKey) => {
    const propertyName = String(propertyKey);
    metadataStorage.registerColumn(target.constructor, propertyName, {
      nullable: true
    });
  };
}
function Default(value) {
  return (target, propertyKey) => {
    const propertyName = String(propertyKey);
    metadataStorage.registerColumn(target.constructor, propertyName, {
      default: value
    });
  };
}
function Index(options) {
  return (target) => {
    metadataStorage.registerIndex(target, {
      name: options.name,
      columns: options.columns,
      unique: options.unique,
      where: options.where
    });
  };
}
function OneToMany(target, inverseSide) {
  return (targetClass, propertyKey) => {
    const propertyName = String(propertyKey);
    metadataStorage.registerRelation(targetClass.constructor, propertyName, {
      propertyName,
      type: "one-to-many",
      target,
      inverseSide
    });
  };
}
function ManyToOne(target, options) {
  return (targetClass, propertyKey) => {
    const propertyName = String(propertyKey);
    metadataStorage.registerRelation(targetClass.constructor, propertyName, {
      propertyName,
      type: "many-to-one",
      target,
      foreignKey: options?.foreignKey
    });
  };
}
function OneToOne(target, options) {
  return (targetClass, propertyKey) => {
    const propertyName = String(propertyKey);
    metadataStorage.registerRelation(targetClass.constructor, propertyName, {
      propertyName,
      type: "one-to-one",
      target,
      foreignKey: options?.foreignKey,
      inverseSide: options?.inverseSide
    });
  };
}
function ManyToMany(target, options) {
  return (targetClass, propertyKey) => {
    const propertyName = String(propertyKey);
    metadataStorage.registerRelation(targetClass.constructor, propertyName, {
      propertyName,
      type: "many-to-many",
      target,
      joinTable: options?.joinTable,
      inverseSide: options?.inverseSide
    });
  };
}
function toSnakeCase(str) {
  return str.replace(/([A-Z])/g, "_$1").toLowerCase().replace(/^_/, "");
}

// src/orm/entity.ts
function applyTenantColumns(target) {
  metadataStorage.registerColumn(target, "app_id", {
    propertyName: "app_id",
    columnName: "app_id",
    type: "string",
    primaryKey: false,
    nullable: false,
    unique: false,
    tenant: true
  });
  metadataStorage.registerColumn(target, "organization_id", {
    propertyName: "organization_id",
    columnName: "organization_id",
    type: "uuid",
    primaryKey: false,
    nullable: false,
    unique: false,
    tenant: true
  });
}
function applyTimestampColumns(target) {
  metadataStorage.registerColumn(target, "created_at", {
    propertyName: "created_at",
    columnName: "created_at",
    type: "datetime",
    primaryKey: false,
    nullable: false,
    unique: false,
    tenant: false,
    default: "NOW()"
  });
  metadataStorage.registerColumn(target, "updated_at", {
    propertyName: "updated_at",
    columnName: "updated_at",
    type: "datetime",
    primaryKey: false,
    nullable: false,
    unique: false,
    tenant: false,
    default: "NOW()"
  });
}
function WithTenantColumns() {
  return (target) => {
    applyTenantColumns(target);
  };
}
function WithTimestamps() {
  return (target) => {
    applyTimestampColumns(target);
  };
}
var TenantEntity = class {
  app_id;
  organization_id;
};
var TimestampedEntity = class {
  created_at;
  updated_at;
};
var TenantTimestampedEntity = class {
  app_id;
  organization_id;
  created_at;
  updated_at;
};

// src/orm/schema-extractor.ts
function extractSchemaFromEntities(entities) {
  const tables = {};
  for (const entity of entities) {
    const metadata = metadataStorage.getEntityMetadata(entity);
    if (!metadata) {
      throw new Error(`Entity ${entity.name} is not decorated with @Entity`);
    }
    tables[metadata.tableName] = extractTableDefinition(metadata);
  }
  return { tables };
}
function extractSchemaFromEntity(entity) {
  return extractSchemaFromEntities([entity]);
}
function extractTableDefinition(metadata) {
  const columns = {};
  const primaryKeyColumns = [];
  for (const [, columnMeta] of metadata.columns) {
    const columnDef = {
      type: columnMeta.type,
      nullable: columnMeta.nullable
    };
    if (columnMeta.primaryKey) {
      columnDef.primaryKey = true;
      primaryKeyColumns.push(columnMeta.columnName);
    }
    if (columnMeta.unique) {
      columnDef.unique = true;
    }
    if (columnMeta.default) {
      columnDef.default = columnMeta.default;
    }
    if (columnMeta.tenant) {
      columnDef.tenant = true;
    }
    if (columnMeta.references) {
      columnDef.references = columnMeta.references;
    }
    columns[columnMeta.columnName] = columnDef;
  }
  const indexes = metadata.indexes.map((idx) => ({
    name: idx.name,
    columns: idx.columns,
    unique: idx.unique,
    where: idx.where
  }));
  const tableDef = {
    columns
  };
  if (indexes.length > 0) {
    tableDef.indexes = indexes;
  }
  if (primaryKeyColumns.length > 1) {
    tableDef.primaryKey = primaryKeyColumns;
  }
  return tableDef;
}
function getEntityTableName(entity) {
  const metadata = metadataStorage.getEntityMetadata(entity);
  if (!metadata) {
    throw new Error(`Entity ${entity.name} is not decorated with @Entity`);
  }
  return metadata.tableName;
}
function getEntityColumns(entity) {
  const metadata = metadataStorage.getEntityMetadata(entity);
  if (!metadata) {
    throw new Error(`Entity ${entity.name} is not decorated with @Entity`);
  }
  const columnMap = /* @__PURE__ */ new Map();
  for (const [propertyName, columnMeta] of metadata.columns) {
    columnMap.set(propertyName, columnMeta.columnName);
  }
  return columnMap;
}
function propertyToColumn(entity, propertyName) {
  const metadata = metadataStorage.getEntityMetadata(entity);
  if (!metadata) {
    throw new Error(`Entity ${entity.name} is not decorated with @Entity`);
  }
  const column = metadata.columns.get(propertyName);
  if (!column) {
    throw new Error(`Property ${propertyName} not found on entity ${entity.name}`);
  }
  return column.columnName;
}
function columnToProperty(entity, columnName) {
  const metadata = metadataStorage.getEntityMetadata(entity);
  if (!metadata) {
    throw new Error(`Entity ${entity.name} is not decorated with @Entity`);
  }
  for (const [propertyName, columnMeta] of metadata.columns) {
    if (columnMeta.columnName === columnName) {
      return propertyName;
    }
  }
  throw new Error(`Column ${columnName} not found on entity ${entity.name}`);
}

// src/orm/repository.ts
var Repository = class {
  db;
  tenantContext;
  tableName;
  columnMap;
  constructor(entity, db, tenantContext) {
    this.db = db;
    this.tenantContext = tenantContext;
    this.tableName = getEntityTableName(entity);
    this.columnMap = getEntityColumns(entity);
  }
  async find(options = {}) {
    const builder = this.createTableBuilder();
    let selectBuilder = builder.select(
      ...options.select ? options.select.map((p) => this.toColumn(p)) : ["*"]
    );
    if (options.where) {
      selectBuilder = this.applyWhere(selectBuilder, options.where);
    }
    if (options.orderBy) {
      for (const [property, direction] of Object.entries(options.orderBy)) {
        selectBuilder = selectBuilder.orderBy(this.toColumn(property), direction);
      }
    }
    if (options.limit !== void 0) {
      selectBuilder = selectBuilder.limit(options.limit);
    }
    if (options.offset !== void 0) {
      selectBuilder = selectBuilder.offset(options.offset);
    }
    const rows = await selectBuilder.execute();
    return rows.map((row) => this.rowToEntity(row));
  }
  async findOne(options = {}) {
    const results = await this.find({ ...options, limit: 1 });
    return results[0] || null;
  }
  async findById(id) {
    return this.findOne({ where: { id } });
  }
  async create(data) {
    const builder = this.createTableBuilder();
    const columnData = this.entityToRow(data);
    const rows = await builder.insert().values(columnData).returning("*").execute();
    if (rows.length === 0) {
      throw new Error("Insert did not return any rows");
    }
    return this.rowToEntity(rows[0]);
  }
  async createMany(data) {
    const results = [];
    for (const item of data) {
      const created = await this.create(item);
      results.push(created);
    }
    return results;
  }
  async update(where, data) {
    const builder = this.createTableBuilder();
    const columnData = this.entityToRow(data);
    let updateBuilder = builder.update().set(columnData);
    updateBuilder = this.applyWhereToUpdate(updateBuilder, where);
    const rows = await updateBuilder.returning("*").execute();
    return rows.map((row) => this.rowToEntity(row));
  }
  async updateById(id, data) {
    const results = await this.update({ id }, data);
    return results[0] || null;
  }
  async delete(where) {
    const builder = this.createTableBuilder();
    let deleteBuilder = builder.delete();
    deleteBuilder = this.applyWhereToDelete(deleteBuilder, where);
    const rows = await deleteBuilder.execute();
    return rows.length;
  }
  async deleteById(id) {
    const count = await this.delete({ id });
    return count > 0;
  }
  async count(where) {
    const builder = this.createTableBuilder();
    const selectBuilder = builder.select();
    if (where) {
      this.applyWhere(selectBuilder, where);
    }
    const countResult = await selectBuilder.count();
    return countResult;
  }
  async exists(where) {
    const count = await this.count(where);
    return count > 0;
  }
  isDbClient(db) {
    return "tableWithoutTenant" in db;
  }
  createTableBuilder() {
    if (this.isDbClient(this.db)) {
      if (!this.tenantContext) {
        throw new Error(
          "TenantContext is required when using Repository with DbClient. Either provide tenantContext or use Repository within a transaction."
        );
      }
      return this.db.table(this.tableName, this.tenantContext);
    }
    return this.db.table(this.tableName);
  }
  toColumn(propertyName) {
    return this.columnMap.get(propertyName) || propertyName;
  }
  applyWhere(builder, where) {
    if (Array.isArray(where)) {
      for (const [property, op, value] of where) {
        builder = builder.where(this.toColumn(property), op, value);
      }
    } else {
      for (const [property, value] of Object.entries(where)) {
        if (value !== void 0) {
          builder = builder.where(this.toColumn(property), "=", value);
        }
      }
    }
    return builder;
  }
  applyWhereToUpdate(builder, where) {
    return this.applyWhere(builder, where);
  }
  applyWhereToDelete(builder, where) {
    return this.applyWhere(builder, where);
  }
  entityToRow(entity) {
    const row = {};
    for (const [property, value] of Object.entries(entity)) {
      if (value !== void 0) {
        const columnName = this.toColumn(property);
        row[columnName] = value;
      }
    }
    return row;
  }
  rowToEntity(row) {
    const entity = {};
    for (const [property, columnName] of this.columnMap) {
      if (columnName in row) {
        entity[property] = row[columnName];
      }
    }
    for (const [key, value] of Object.entries(row)) {
      if (!(key in entity)) {
        entity[key] = value;
      }
    }
    return entity;
  }
};
function createRepository(entity, db, tenantContext) {
  return new Repository(entity, db, tenantContext);
}

// src/index.ts
init_driver();
init_compiler();
init_query_builder();

// src/migrations/index.ts
init_runner();
init_dialects();

// src/modules/registry.ts
init_dialects();
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
function createModuleRegistry(driver, options = {}) {
  return new ModuleRegistry(driver, options);
}

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
function createMigrationCollector() {
  return new MigrationCollector();
}

// src/schema/index.ts
init_registry();

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
function createSchemaIntrospector(driver, dialect) {
  return new SchemaIntrospector(driver, dialect);
}

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
function createSchemaDiffEngine(dialect) {
  return new SchemaDiffEngine(dialect);
}

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
function createSyncMetadataManager(driver, dialect, options) {
  return new SyncMetadataManager(driver, dialect, options);
}

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
var ConflictError = class extends Error {
  constructor(message, conflicts = []) {
    super(message);
    this.conflicts = conflicts;
    this.name = "ConflictError";
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

// src/remote/auth.ts
import { mkdir, readFile as readFile3, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join as join3 } from "path";
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
function generateSchemaFromDefinition(schema) {
  const lines = [
    "import type { SchemaDefinition } from '@launchpad/db-engine';",
    "",
    "export const schema: SchemaDefinition = {",
    "  tables: {"
  ];
  for (const [tableName, table] of Object.entries(schema.tables)) {
    lines.push(`    ${tableName}: {`);
    lines.push("      columns: {");
    for (const [colName, col] of Object.entries(table.columns)) {
      const colDef = [];
      colDef.push(`type: '${col.type}'`);
      if (col.primaryKey) colDef.push("primaryKey: true");
      if (col.nullable) colDef.push("nullable: true");
      if (col.unique) colDef.push("unique: true");
      if (col.default) colDef.push(`default: '${col.default}'`);
      if (col.tenant) colDef.push("tenant: true");
      if (col.references) {
        colDef.push(
          `references: { table: '${col.references.table}', column: '${col.references.column}'${col.references.onDelete ? `, onDelete: '${col.references.onDelete}'` : ""} }`
        );
      }
      lines.push(`        ${colName}: { ${colDef.join(", ")} },`);
    }
    lines.push("      },");
    if (table.indexes?.length) {
      lines.push("      indexes: [");
      for (const index of table.indexes) {
        const indexDef = [];
        indexDef.push(`columns: [${index.columns.map((c) => `'${c}'`).join(", ")}]`);
        if (index.name) indexDef.push(`name: '${index.name}'`);
        if (index.unique) indexDef.push("unique: true");
        if (index.where) indexDef.push(`where: '${index.where}'`);
        lines.push(`        { ${indexDef.join(", ")} },`);
      }
      lines.push("      ],");
    }
    lines.push("    },");
  }
  lines.push("  },");
  lines.push("};");
  return lines.join("\n");
}

// src/index.ts
init_client();
init_tenant_validation();

// src/seed/base.ts
var defaultLogger2 = {
  info: (msg) => console.log(msg),
  warn: (msg) => console.warn(msg),
  error: (msg) => console.error(msg)
};
var Seeder = class {
  static order = 0;
  static dependencies = [];
  static version = 1;
  driver;
  logger;
  constructor(driver, logger) {
    this.driver = driver;
    this.logger = logger ?? defaultLogger2;
  }
  async rollback() {
    throw new Error("Rollback not implemented");
  }
  get metadata() {
    const ctor = this.constructor;
    return {
      name: this.constructor.name.replace(/Seeder$/, "").toLowerCase(),
      order: ctor.order,
      dependencies: ctor.dependencies,
      version: ctor.version
    };
  }
  async query(sql, params) {
    return this.driver.query(sql, params);
  }
  async execute(sql, params) {
    return this.driver.execute(sql, params);
  }
  async transaction(fn) {
    return this.driver.transaction(fn);
  }
};

// src/seed/loader.ts
import { readFile as readFile4, readdir as readdir3 } from "fs/promises";
import { basename, join as join4 } from "path";
import { pathToFileURL } from "url";

// src/seed/sql-adapter.ts
var SqlSeederAdapter = class extends Seeder {
  sqlContent;
  seederName;
  constructor(driver, sqlContent, name, logger) {
    super(driver, logger);
    this.sqlContent = sqlContent;
    this.seederName = name;
  }
  get name() {
    return this.seederName;
  }
  async run() {
    const statements = this.splitStatements(this.sqlContent);
    let totalCount = 0;
    for (const sql of statements) {
      if (sql.trim()) {
        const result = await this.execute(sql);
        totalCount += result.rowCount;
      }
    }
    return { count: totalCount };
  }
  splitStatements(sql) {
    const statements = [];
    let current = "";
    let inQuote = false;
    let quoteChar = "";
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
      if (inQuote) {
        current += char;
        if (char === quoteChar && next !== quoteChar) {
          inQuote = false;
        } else if (char === quoteChar && next === quoteChar) {
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
      if (char === "'" || char === '"') {
        inQuote = true;
        quoteChar = char;
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

// src/seed/loader.ts
var SeedLoader = class {
  seedsPath;
  constructor(options = {}) {
    this.seedsPath = options.seedsPath ?? "./seeds";
  }
  async discover() {
    const files = await this.findSeedFiles();
    const seeders = [];
    for (const file of files) {
      if (file.endsWith(".ts") || file.endsWith(".js")) {
        seeders.push(await this.loadTypeScriptSeeder(file));
      } else if (file.endsWith(".sql")) {
        seeders.push(await this.loadSqlSeeder(file));
      }
    }
    return this.sortByDependencies(seeders);
  }
  async findSeedFiles() {
    try {
      const files = await readdir3(this.seedsPath);
      return files.filter((f) => f.endsWith(".ts") || f.endsWith(".js") || f.endsWith(".sql")).filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".spec.ts")).filter((f) => f !== "index.ts" && f !== "index.js").sort();
    } catch (error) {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }
  async loadTypeScriptSeeder(filename) {
    const fullPath = join4(this.seedsPath, filename);
    const fileUrl = pathToFileURL(fullPath).href;
    const module = await import(fileUrl);
    const SeederClass = module.default;
    if (!SeederClass || typeof SeederClass !== "function") {
      throw new Error(`Seeder file ${filename} must export a default class extending Seeder`);
    }
    const name = this.extractName(filename);
    const order = SeederClass.order ?? this.extractOrderFromFilename(filename);
    const dependencies = SeederClass.dependencies ?? [];
    return {
      name,
      path: fullPath,
      type: "typescript",
      order,
      dependencies,
      SeederClass
    };
  }
  async loadSqlSeeder(filename) {
    const fullPath = join4(this.seedsPath, filename);
    const sqlContent = await readFile4(fullPath, "utf-8");
    const name = this.extractName(filename);
    const order = this.extractOrderFromFilename(filename);
    return {
      name,
      path: fullPath,
      type: "sql",
      order,
      dependencies: [],
      sqlContent
    };
  }
  extractName(filename) {
    const base = basename(filename).replace(/\.(ts|js|sql)$/, "");
    return base.replace(/^\d+[-_]/, "");
  }
  extractOrderFromFilename(filename) {
    const match = filename.match(/^(\d+)[-_]/);
    return match ? Number.parseInt(match[1], 10) : 999;
  }
  sortByDependencies(seeders) {
    return this.topologicalSort(seeders);
  }
  topologicalSort(seeders) {
    const seederMap = new Map(seeders.map((s) => [s.name, s]));
    const inDegree = /* @__PURE__ */ new Map();
    const graph = /* @__PURE__ */ new Map();
    for (const seeder of seeders) {
      inDegree.set(seeder.name, seeder.dependencies.length);
      graph.set(seeder.name, []);
    }
    for (const seeder of seeders) {
      for (const dep of seeder.dependencies) {
        if (!seederMap.has(dep)) {
          throw new Error(`Seeder "${seeder.name}" depends on unknown seeder "${dep}"`);
        }
        graph.get(dep).push(seeder.name);
      }
    }
    const queue = seeders.filter((s) => inDegree.get(s.name) === 0);
    queue.sort((a, b) => a.order - b.order);
    const result = [];
    while (queue.length > 0) {
      queue.sort((a, b) => a.order - b.order);
      const current = queue.shift();
      result.push(current);
      for (const dependent of graph.get(current.name)) {
        const newDegree = inDegree.get(dependent) - 1;
        inDegree.set(dependent, newDegree);
        if (newDegree === 0) {
          queue.push(seederMap.get(dependent));
        }
      }
    }
    if (result.length !== seeders.length) {
      const remaining = seeders.filter((s) => !result.includes(s)).map((s) => s.name);
      throw new Error(`Circular dependency detected in seeders: ${remaining.join(", ")}`);
    }
    return result;
  }
  createInstance(loaded, driver, logger) {
    if (loaded.type === "typescript" && loaded.SeederClass) {
      return new loaded.SeederClass(driver, logger);
    }
    if (loaded.type === "sql" && loaded.sqlContent) {
      return new SqlSeederAdapter(driver, loaded.sqlContent, loaded.name, logger);
    }
    throw new Error(`Cannot create instance for seeder: ${loaded.name}`);
  }
};

// src/seed/runner.ts
init_dialects();

// src/seed/tracker.ts
init_dialects();
var SeedTracker = class {
  driver;
  dialect;
  tableName;
  constructor(driver, options = {}) {
    this.driver = driver;
    this.dialect = getDialect(driver.dialect);
    this.tableName = options.tableName ?? "lp_seeds";
  }
  async ensureTable() {
    const sql = this.dialect.name === "postgresql" ? `
        CREATE TABLE IF NOT EXISTS "${this.tableName}" (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          executed_at TIMESTAMPTZ DEFAULT NOW(),
          execution_time_ms INTEGER,
          record_count INTEGER,
          checksum VARCHAR(64),
          UNIQUE(name, version)
        )
      ` : this.dialect.name === "mysql" ? `
          CREATE TABLE IF NOT EXISTS \`${this.tableName}\` (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            version INT NOT NULL DEFAULT 1,
            executed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            execution_time_ms INT,
            record_count INT,
            checksum VARCHAR(64),
            UNIQUE KEY unique_name_version (name, version)
          )
        ` : `
          CREATE TABLE IF NOT EXISTS "${this.tableName}" (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            executed_at TEXT DEFAULT (datetime('now')),
            execution_time_ms INTEGER,
            record_count INTEGER,
            checksum TEXT,
            UNIQUE(name, version)
          )
        `;
    await this.driver.execute(sql);
  }
  async hasRun(name, version) {
    const sql = this.dialect.name === "postgresql" ? `SELECT 1 FROM "${this.tableName}" WHERE name = $1 AND version = $2` : `SELECT 1 FROM ${this.dialect.name === "mysql" ? `\`${this.tableName}\`` : `"${this.tableName}"`} WHERE name = ? AND version = ?`;
    const params = [name, version];
    const result = await this.driver.query(sql, params);
    return result.rows.length > 0;
  }
  async record(name, version, result, duration) {
    const sql = this.dialect.name === "postgresql" ? `
        INSERT INTO "${this.tableName}" (name, version, execution_time_ms, record_count)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (name, version) DO UPDATE SET
          execution_time_ms = EXCLUDED.execution_time_ms,
          record_count = EXCLUDED.record_count,
          executed_at = NOW()
      ` : this.dialect.name === "mysql" ? `
          INSERT INTO \`${this.tableName}\` (name, version, execution_time_ms, record_count)
          VALUES (?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            execution_time_ms = VALUES(execution_time_ms),
            record_count = VALUES(record_count),
            executed_at = CURRENT_TIMESTAMP
        ` : `
          INSERT OR REPLACE INTO "${this.tableName}" (name, version, execution_time_ms, record_count)
          VALUES (?, ?, ?, ?)
        `;
    const params = [name, version, duration, result.count];
    await this.driver.execute(sql, params);
  }
  async remove(name) {
    const sql = this.dialect.name === "postgresql" ? `DELETE FROM "${this.tableName}" WHERE name = $1` : `DELETE FROM ${this.dialect.name === "mysql" ? `\`${this.tableName}\`` : `"${this.tableName}"`} WHERE name = ?`;
    await this.driver.execute(sql, [name]);
  }
  async clear() {
    const sql = this.dialect.name === "mysql" ? `TRUNCATE TABLE \`${this.tableName}\`` : `DELETE FROM "${this.tableName}"`;
    await this.driver.execute(sql);
  }
  async list() {
    const sql = this.dialect.name === "postgresql" ? `SELECT * FROM "${this.tableName}" ORDER BY executed_at DESC` : `SELECT * FROM ${this.dialect.name === "mysql" ? `\`${this.tableName}\`` : `"${this.tableName}"`} ORDER BY executed_at DESC`;
    const result = await this.driver.query(sql);
    return result.rows;
  }
};

// src/seed/runner.ts
var defaultLogger3 = {
  info: (msg) => console.log(msg),
  warn: (msg) => console.warn(msg),
  error: (msg) => console.error(msg)
};
var SeedRunner = class {
  driver;
  dialect;
  loader;
  tracker;
  logger;
  constructor(driver, options = {}) {
    this.driver = driver;
    this.dialect = getDialect(driver.dialect);
    this.loader = new SeedLoader({ seedsPath: options.seedsPath });
    this.tracker = new SeedTracker(driver, { tableName: options.tableName });
    this.logger = defaultLogger3;
  }
  async run(options = {}) {
    if (process.env.NODE_ENV === "production" && !options.allowProduction) {
      throw new Error(
        "Seeding in production is disabled by default. Use --allow-production flag to override (dangerous!)."
      );
    }
    await this.tracker.ensureTable();
    const allSeeders = await this.loader.discover();
    const filtered = this.filterSeeders(allSeeders, options);
    if (filtered.length === 0) {
      return { success: true, seeders: [], totalCount: 0, totalDuration: 0 };
    }
    if (options.fresh) {
      await this.truncateTables(filtered);
    }
    const result = {
      success: true,
      seeders: [],
      totalCount: 0,
      totalDuration: 0
    };
    const startTime = Date.now();
    for (const loaded of filtered) {
      const seederResult = await this.executeSeeder(loaded, options);
      result.seeders.push(seederResult);
      result.totalCount += seederResult.count;
      if (seederResult.status === "failed") {
        result.success = false;
        break;
      }
    }
    result.totalDuration = Date.now() - startTime;
    return result;
  }
  async rollback(seederName) {
    const allSeeders = await this.loader.discover();
    const toRollback = seederName ? allSeeders.filter((s) => s.name === seederName) : allSeeders.reverse();
    for (const loaded of toRollback) {
      const instance = this.loader.createInstance(loaded, this.driver, this.logger);
      try {
        await instance.rollback();
        await this.tracker.remove(loaded.name);
        this.logger.info(`Rolled back: ${loaded.name}`);
      } catch {
        this.logger.warn(`Rollback not implemented for: ${loaded.name}`);
      }
    }
  }
  async status() {
    await this.tracker.ensureTable();
    const records = await this.tracker.list();
    const seeders = records.map((r) => ({
      name: r.name,
      status: "success",
      count: r.record_count,
      duration: r.execution_time_ms
    }));
    return {
      success: true,
      seeders,
      totalCount: seeders.reduce((sum, s) => sum + s.count, 0),
      totalDuration: seeders.reduce((sum, s) => sum + s.duration, 0)
    };
  }
  filterSeeders(seeders, options) {
    if (!options.only) return seeders;
    const target = seeders.find((s) => s.name.toLowerCase() === options.only.toLowerCase());
    if (!target) {
      throw new Error(`Seeder not found: ${options.only}`);
    }
    const required = this.resolveDependencies(target, seeders);
    return required;
  }
  resolveDependencies(target, all) {
    const result = [];
    const visited = /* @__PURE__ */ new Set();
    const visit = (seeder) => {
      if (visited.has(seeder.name)) return;
      visited.add(seeder.name);
      for (const depName of seeder.dependencies) {
        const dep = all.find((s) => s.name === depName);
        if (dep) visit(dep);
      }
      result.push(seeder);
    };
    visit(target);
    return result;
  }
  async executeSeeder(loaded, options) {
    const startTime = Date.now();
    if (!options.force) {
      const version = loaded.SeederClass?.version ?? 1;
      const hasRun = await this.tracker.hasRun(loaded.name, version);
      if (hasRun) {
        return {
          name: loaded.name,
          status: "skipped",
          count: 0,
          duration: 0
        };
      }
    }
    try {
      const instance = this.loader.createInstance(loaded, this.driver, this.logger);
      let seedResult;
      if (options.dryRun) {
        seedResult = await this.dryRunSeeder(instance);
      } else {
        seedResult = await this.runWithTransaction(instance);
        const version = loaded.SeederClass?.version ?? 1;
        await this.tracker.record(loaded.name, version, seedResult, Date.now() - startTime);
      }
      return {
        name: loaded.name,
        status: "success",
        count: seedResult.count,
        duration: Date.now() - startTime
      };
    } catch (error) {
      return {
        name: loaded.name,
        status: "failed",
        count: 0,
        duration: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
  async runWithTransaction(seeder) {
    if (this.dialect.supportsTransactionalDDL) {
      return this.driver.transaction(async () => {
        return seeder.run();
      });
    }
    return seeder.run();
  }
  async dryRunSeeder(seeder) {
    await this.driver.execute("BEGIN");
    try {
      const result = await seeder.run();
      return result;
    } finally {
      await this.driver.execute("ROLLBACK");
    }
  }
  async truncateTables(seeders) {
    const tables = seeders.map((s) => s.name).reverse();
    for (const table of tables) {
      try {
        if (this.dialect.name === "postgresql") {
          await this.driver.execute(`TRUNCATE TABLE "${table}" CASCADE`);
        } else if (this.dialect.name === "mysql") {
          await this.driver.execute("SET FOREIGN_KEY_CHECKS = 0");
          await this.driver.execute(`TRUNCATE TABLE \`${table}\``);
          await this.driver.execute("SET FOREIGN_KEY_CHECKS = 1");
        } else {
          await this.driver.execute(`DELETE FROM "${table}"`);
        }
      } catch {
      }
    }
    await this.tracker.clear();
  }
};
function createSeedRunner(driver, options) {
  return new SeedRunner(driver, options);
}

// src/branch/schema-differ.ts
var SchemaDiffer = class {
  constructor(driver) {
    this.driver = driver;
  }
  async diff(sourceSchema, targetSchema) {
    const [sourceInfo, targetInfo] = await Promise.all([
      this.getSchemaInfo(sourceSchema),
      this.getSchemaInfo(targetSchema)
    ]);
    const tables = this.diffTables(sourceInfo, targetInfo);
    const columns = this.diffColumns(sourceInfo, targetInfo);
    const indexes = this.diffIndexes(sourceInfo, targetInfo);
    const constraints = this.diffConstraints(sourceInfo, targetInfo);
    const conflicts = this.detectConflicts(columns, constraints);
    const hasChanges = tables.length > 0 || columns.length > 0 || indexes.length > 0 || constraints.length > 0;
    return {
      source: sourceSchema,
      target: targetSchema,
      generatedAt: /* @__PURE__ */ new Date(),
      hasChanges,
      canAutoMerge: conflicts.length === 0,
      tables,
      columns,
      indexes,
      constraints,
      conflicts,
      forwardSql: this.generateMigrationSql(
        sourceSchema,
        targetSchema,
        tables,
        columns,
        indexes,
        constraints,
        "forward"
      ),
      reverseSql: this.generateMigrationSql(
        targetSchema,
        sourceSchema,
        tables,
        columns,
        indexes,
        constraints,
        "reverse"
      )
    };
  }
  async getSchemaInfo(schemaName) {
    const [tables, columns, indexes, constraints] = await Promise.all([
      this.driver.query(
        `
        SELECT table_name, table_type
        FROM information_schema.tables
        WHERE table_schema = $1 AND table_name NOT LIKE 'lp_%'
        ORDER BY table_name
      `,
        [schemaName]
      ),
      this.driver.query(
        `
        SELECT
          table_name, column_name, data_type,
          character_maximum_length, numeric_precision, numeric_scale,
          is_nullable, column_default, udt_name, ordinal_position
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name NOT LIKE 'lp_%'
        ORDER BY table_name, ordinal_position
      `,
        [schemaName]
      ),
      this.driver.query(
        `
        SELECT
          schemaname, tablename, indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = $1 AND tablename NOT LIKE 'lp_%'
        ORDER BY tablename, indexname
      `,
        [schemaName]
      ),
      this.driver.query(
        `
        SELECT
          tc.table_name, tc.constraint_name, tc.constraint_type,
          kcu.column_name, ccu.table_name AS foreign_table_name,
          ccu.column_name AS foreign_column_name
        FROM information_schema.table_constraints tc
        LEFT JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        LEFT JOIN information_schema.constraint_column_usage ccu
          ON tc.constraint_name = ccu.constraint_name
          AND tc.table_schema = ccu.table_schema
        WHERE tc.table_schema = $1 AND tc.table_name NOT LIKE 'lp_%'
        ORDER BY tc.table_name, tc.constraint_name
      `,
        [schemaName]
      )
    ]);
    return {
      tables: tables.rows,
      columns: columns.rows,
      indexes: indexes.rows,
      constraints: constraints.rows
    };
  }
  diffTables(source, target) {
    const diffs = [];
    const sourceNames = new Set(source.tables.map((t) => t.table_name));
    const targetNames = new Set(target.tables.map((t) => t.table_name));
    for (const table of source.tables) {
      if (!targetNames.has(table.table_name)) {
        diffs.push({
          name: table.table_name,
          action: "added",
          sourceDefinition: this.getTableDefinition(table.table_name, source)
        });
      }
    }
    for (const table of target.tables) {
      if (!sourceNames.has(table.table_name)) {
        diffs.push({
          name: table.table_name,
          action: "removed",
          targetDefinition: this.getTableDefinition(table.table_name, target)
        });
      }
    }
    return diffs;
  }
  diffColumns(source, target) {
    const diffs = [];
    const sourceTableNames = new Set(source.tables.map((t) => t.table_name));
    const targetTableNames = new Set(target.tables.map((t) => t.table_name));
    const commonTables = [...sourceTableNames].filter((t) => targetTableNames.has(t));
    for (const tableName of commonTables) {
      const sourceCols = source.columns.filter((c) => c.table_name === tableName);
      const targetCols = target.columns.filter((c) => c.table_name === tableName);
      const sourceColMap = new Map(sourceCols.map((c) => [c.column_name, c]));
      const targetColMap = new Map(targetCols.map((c) => [c.column_name, c]));
      diffs.push(...this.findAddedColumns(tableName, sourceCols, targetColMap));
      diffs.push(...this.findRemovedColumns(tableName, targetCols, sourceColMap));
      diffs.push(...this.findModifiedColumns(tableName, sourceCols, targetColMap));
    }
    return diffs;
  }
  findAddedColumns(tableName, sourceCols, targetColMap) {
    return sourceCols.filter((col) => !targetColMap.has(col.column_name)).map((col) => ({
      tableName,
      columnName: col.column_name,
      action: "added",
      sourceType: this.getColumnType(col),
      sourceNullable: col.is_nullable === "YES",
      sourceDefault: col.column_default ?? void 0,
      isBreaking: false
    }));
  }
  findRemovedColumns(tableName, targetCols, sourceColMap) {
    return targetCols.filter((col) => !sourceColMap.has(col.column_name)).map((col) => ({
      tableName,
      columnName: col.column_name,
      action: "removed",
      targetType: this.getColumnType(col),
      targetNullable: col.is_nullable === "YES",
      targetDefault: col.column_default ?? void 0,
      isBreaking: true
    }));
  }
  findModifiedColumns(tableName, sourceCols, targetColMap) {
    const diffs = [];
    for (const col of sourceCols) {
      const targetCol = targetColMap.get(col.column_name);
      if (targetCol && this.hasColumnChanges(col, targetCol)) {
        const sourceType = this.getColumnType(col);
        const targetType = this.getColumnType(targetCol);
        diffs.push({
          tableName,
          columnName: col.column_name,
          action: "modified",
          sourceType,
          targetType,
          sourceNullable: col.is_nullable === "YES",
          targetNullable: targetCol.is_nullable === "YES",
          sourceDefault: col.column_default ?? void 0,
          targetDefault: targetCol.column_default ?? void 0,
          isBreaking: this.isBreakingTypeChange(sourceType, targetType)
        });
      }
    }
    return diffs;
  }
  diffIndexes(source, target) {
    const diffs = [];
    const sourceMap = new Map(source.indexes.map((i) => [`${i.tablename}.${i.indexname}`, i]));
    const targetMap = new Map(target.indexes.map((i) => [`${i.tablename}.${i.indexname}`, i]));
    for (const [key, idx] of sourceMap) {
      if (!targetMap.has(key)) {
        diffs.push({
          tableName: idx.tablename,
          indexName: idx.indexname,
          action: "added",
          sourceDefinition: idx.indexdef
        });
      }
    }
    for (const [key, idx] of targetMap) {
      if (!sourceMap.has(key)) {
        diffs.push({
          tableName: idx.tablename,
          indexName: idx.indexname,
          action: "removed",
          targetDefinition: idx.indexdef
        });
      }
    }
    for (const [key, sourceIdx] of sourceMap) {
      const targetIdx = targetMap.get(key);
      if (targetIdx) {
        const normalizedSource = this.normalizeIndexDef(sourceIdx.indexdef);
        const normalizedTarget = this.normalizeIndexDef(targetIdx.indexdef);
        if (normalizedSource !== normalizedTarget) {
          diffs.push({
            tableName: sourceIdx.tablename,
            indexName: sourceIdx.indexname,
            action: "modified",
            sourceDefinition: sourceIdx.indexdef,
            targetDefinition: targetIdx.indexdef
          });
        }
      }
    }
    return diffs;
  }
  diffConstraints(source, target) {
    const diffs = [];
    const sourceMap = new Map(
      source.constraints.map((c) => [`${c.table_name}.${c.constraint_name}`, c])
    );
    const targetMap = new Map(
      target.constraints.map((c) => [`${c.table_name}.${c.constraint_name}`, c])
    );
    for (const [key, con] of sourceMap) {
      if (!targetMap.has(key) && !this.isAutoGeneratedConstraint(con.constraint_name)) {
        diffs.push({
          tableName: con.table_name,
          constraintName: con.constraint_name,
          constraintType: this.mapConstraintType(con.constraint_type),
          action: "added",
          isBreaking: false,
          sourceDefinition: this.getConstraintDefinition(con)
        });
      }
    }
    for (const [key, con] of targetMap) {
      if (!sourceMap.has(key) && !this.isAutoGeneratedConstraint(con.constraint_name)) {
        diffs.push({
          tableName: con.table_name,
          constraintName: con.constraint_name,
          constraintType: this.mapConstraintType(con.constraint_type),
          action: "removed",
          isBreaking: con.constraint_type !== "CHECK",
          targetDefinition: this.getConstraintDefinition(con)
        });
      }
    }
    return diffs;
  }
  detectConflicts(columns, constraints) {
    const conflicts = [];
    for (const col of columns.filter((c) => c.action === "modified")) {
      if (col.sourceType !== col.targetType) {
        conflicts.push({
          type: "column_type_mismatch",
          description: `Column ${col.tableName}.${col.columnName} has different types: ${col.sourceType} vs ${col.targetType}`,
          sourcePath: `${col.tableName}.${col.columnName}`,
          targetPath: `${col.tableName}.${col.columnName}`,
          resolution: ["keep_source", "keep_target", "manual"]
        });
      }
    }
    for (const con of constraints.filter(
      (c) => c.action === "removed" && c.constraintType === "foreign_key"
    )) {
      conflicts.push({
        type: "constraint_conflict",
        description: `Foreign key ${con.constraintName} on ${con.tableName} would be removed`,
        sourcePath: `${con.tableName}.${con.constraintName}`,
        targetPath: `${con.tableName}.${con.constraintName}`,
        resolution: ["keep_source", "keep_target", "manual"]
      });
    }
    return conflicts;
  }
  generateMigrationSql(sourceSchema, targetSchema, tables, columns, indexes, constraints, direction) {
    const schema = direction === "forward" ? targetSchema : sourceSchema;
    const ctx = { sourceSchema, targetSchema, schema, direction };
    return [
      ...this.generateTableSql(tables, ctx),
      ...this.generateColumnSql(columns, ctx),
      ...this.generateIndexSql(indexes, ctx),
      ...this.generateConstraintSql(constraints, ctx)
    ];
  }
  generateTableSql(tables, ctx) {
    const sql = [];
    for (const table of tables) {
      const isCreate = ctx.direction === "forward" && table.action === "added" || ctx.direction === "reverse" && table.action === "removed";
      const isDrop = ctx.direction === "forward" && table.action === "removed" || ctx.direction === "reverse" && table.action === "added";
      if (isCreate && table.sourceDefinition) {
        sql.push(table.sourceDefinition.replace(ctx.sourceSchema, ctx.schema));
      } else if (isDrop) {
        sql.push(`DROP TABLE IF EXISTS "${ctx.schema}"."${table.name}" CASCADE`);
      }
    }
    return sql;
  }
  shouldCreate(action, direction) {
    return direction === "forward" && action === "added" || direction === "reverse" && action === "removed";
  }
  shouldDrop(action, direction) {
    return direction === "forward" && action === "removed" || direction === "reverse" && action === "added";
  }
  generateColumnSql(columns, ctx) {
    return columns.flatMap((col) => this.generateSingleColumnSql(col, ctx));
  }
  generateSingleColumnSql(col, ctx) {
    const tableName = `"${ctx.schema}"."${col.tableName}"`;
    if (this.shouldCreate(col.action, ctx.direction)) {
      const type = ctx.direction === "forward" ? col.sourceType : col.targetType;
      return [`ALTER TABLE ${tableName} ADD COLUMN "${col.columnName}" ${type}`];
    }
    if (this.shouldDrop(col.action, ctx.direction)) {
      return [`ALTER TABLE ${tableName} DROP COLUMN IF EXISTS "${col.columnName}"`];
    }
    if (col.action === "modified") {
      const type = ctx.direction === "forward" ? col.sourceType : col.targetType;
      return [`ALTER TABLE ${tableName} ALTER COLUMN "${col.columnName}" TYPE ${type}`];
    }
    return [];
  }
  generateIndexSql(indexes, ctx) {
    return indexes.flatMap((idx) => this.generateSingleIndexSql(idx, ctx));
  }
  generateSingleIndexSql(idx, ctx) {
    if (this.shouldCreate(idx.action, ctx.direction)) {
      const def = ctx.direction === "forward" ? idx.sourceDefinition : idx.targetDefinition;
      if (def) {
        return [def.replace(ctx.sourceSchema, ctx.schema).replace(ctx.targetSchema, ctx.schema)];
      }
    }
    if (this.shouldDrop(idx.action, ctx.direction)) {
      return [`DROP INDEX IF EXISTS "${ctx.schema}"."${idx.indexName}"`];
    }
    return [];
  }
  generateConstraintSql(constraints, ctx) {
    return constraints.flatMap((con) => this.generateSingleConstraintSql(con, ctx));
  }
  generateSingleConstraintSql(con, ctx) {
    const tableName = `"${ctx.schema}"."${con.tableName}"`;
    if (this.shouldCreate(con.action, ctx.direction)) {
      const def = ctx.direction === "forward" ? con.sourceDefinition : con.targetDefinition;
      if (def) {
        return [`ALTER TABLE ${tableName} ADD ${def}`];
      }
    }
    if (this.shouldDrop(con.action, ctx.direction)) {
      return [`ALTER TABLE ${tableName} DROP CONSTRAINT IF EXISTS "${con.constraintName}"`];
    }
    return [];
  }
  getTableDefinition(tableName, schema) {
    const columns = schema.columns.filter((c) => c.table_name === tableName);
    const colDefs = columns.map((c) => {
      let def = `"${c.column_name}" ${this.getColumnType(c)}`;
      if (c.is_nullable === "NO") {
        def += " NOT NULL";
      }
      if (c.column_default) {
        def += ` DEFAULT ${c.column_default}`;
      }
      return def;
    });
    return `CREATE TABLE "${tableName}" (
  ${colDefs.join(",\n  ")}
)`;
  }
  getColumnType(col) {
    let type = col.data_type;
    if (col.character_maximum_length) {
      type = `${col.udt_name}(${col.character_maximum_length})`;
    } else if (col.numeric_precision && col.numeric_scale !== null) {
      type = `${col.udt_name}(${col.numeric_precision},${col.numeric_scale})`;
    } else if (col.udt_name && col.udt_name !== col.data_type) {
      type = col.udt_name;
    }
    return type.toUpperCase();
  }
  hasColumnChanges(source, target) {
    return this.getColumnType(source) !== this.getColumnType(target) || source.is_nullable !== target.is_nullable || this.normalizeDefault(source.column_default) !== this.normalizeDefault(target.column_default);
  }
  normalizeDefault(value) {
    if (!value) return value;
    return value.replace(/nextval\('[^']+\./g, "nextval('");
  }
  isBreakingTypeChange(sourceType, targetType) {
    const breakingChanges = [
      { from: "TEXT", to: "VARCHAR" },
      { from: "VARCHAR", to: "INTEGER" },
      { from: "INTEGER", to: "SMALLINT" },
      { from: "BIGINT", to: "INTEGER" },
      { from: "TIMESTAMP", to: "DATE" }
    ];
    const source = sourceType.toUpperCase();
    const target = targetType.toUpperCase();
    return breakingChanges.some(
      (change) => source.includes(change.from) && target.includes(change.to)
    );
  }
  isAutoGeneratedConstraint(name) {
    return /^\d+_\d+_\d+_not_null$/.test(name);
  }
  normalizeIndexDef(indexdef) {
    return indexdef.replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ").replace(/\bON\s+\S+\./gi, "ON ").toLowerCase().trim();
  }
  mapConstraintType(type) {
    switch (type) {
      case "PRIMARY KEY":
        return "primary_key";
      case "FOREIGN KEY":
        return "foreign_key";
      case "UNIQUE":
        return "unique";
      case "CHECK":
        return "check";
      default:
        return "check";
    }
  }
  getConstraintDefinition(con) {
    if (con.constraint_type === "FOREIGN KEY" && con.foreign_table_name && con.foreign_column_name) {
      return `CONSTRAINT "${con.constraint_name}" FOREIGN KEY ("${con.column_name}") REFERENCES "${con.foreign_table_name}"("${con.foreign_column_name}")`;
    }
    if (con.constraint_type === "PRIMARY KEY") {
      return `CONSTRAINT "${con.constraint_name}" PRIMARY KEY ("${con.column_name}")`;
    }
    if (con.constraint_type === "UNIQUE") {
      return `CONSTRAINT "${con.constraint_name}" UNIQUE ("${con.column_name}")`;
    }
    return `CONSTRAINT "${con.constraint_name}"`;
  }
};

// src/branch/migration-merger.ts
var MigrationMerger = class {
  driver;
  mainSchema;
  migrationsTable;
  constructor(driver, options = {}) {
    this.driver = driver;
    this.mainSchema = options.mainSchema ?? "public";
    this.migrationsTable = options.migrationsTable ?? "lp_migrations";
  }
  async merge(options) {
    const { sourceBranch, targetBranch, dryRun, conflictResolution } = options;
    const sourceSchema = await this.resolveSchemaName(sourceBranch);
    const targetSchema = await this.resolveSchemaName(targetBranch);
    const differ = new SchemaDiffer(this.driver);
    const diff = await differ.diff(sourceSchema, targetSchema);
    if (!diff.hasChanges) {
      return {
        success: true,
        migrationsApplied: 0,
        conflicts: [],
        errors: [],
        rollbackAvailable: false
      };
    }
    if (diff.conflicts.length > 0 && !this.allConflictsResolved(diff.conflicts, conflictResolution)) {
      return {
        success: false,
        migrationsApplied: 0,
        conflicts: diff.conflicts,
        errors: ["Unresolved conflicts detected. Provide conflict resolutions."],
        rollbackAvailable: false
      };
    }
    if (dryRun) {
      return {
        success: true,
        migrationsApplied: diff.forwardSql.length,
        conflicts: [],
        errors: [],
        rollbackAvailable: false
      };
    }
    try {
      await this.driver.transaction(async (trx) => {
        for (const sql of diff.forwardSql) {
          const adjustedSql = sql.replace(
            new RegExp(`"${sourceSchema}"`, "g"),
            `"${targetSchema}"`
          );
          await trx.execute(adjustedSql);
        }
        await trx.execute(
          `
          INSERT INTO ${this.quoteIdent(this.migrationsTable)} (
            version, name, scope, checksum, up_sql, down_sql
          ) VALUES (
            EXTRACT(EPOCH FROM NOW())::BIGINT * 1000 + (random() * 1000)::INT,
            $1,
            'core',
            $2,
            $3,
            $4
          )
        `,
          [
            `merge_${sourceBranch}_to_${targetBranch}`,
            this.computeChecksum(diff.forwardSql),
            diff.forwardSql,
            diff.reverseSql
          ]
        );
      });
      return {
        success: true,
        migrationsApplied: diff.forwardSql.length,
        conflicts: [],
        errors: [],
        rollbackAvailable: true
      };
    } catch (error) {
      return {
        success: false,
        migrationsApplied: 0,
        conflicts: [],
        errors: [error instanceof Error ? error.message : String(error)],
        rollbackAvailable: false
      };
    }
  }
  async getPendingMigrations(_sourceBranch, _targetBranch) {
    const result = await this.driver.query(`
      SELECT s.version, s.name, s.scope, s.checksum, s.up_sql, s.down_sql, s.applied_at
      FROM ${this.quoteIdent(this.migrationsTable)} s
      WHERE NOT EXISTS (
        SELECT 1 FROM ${this.quoteIdent(this.migrationsTable)} t
        WHERE t.version = s.version
      )
      ORDER BY s.version ASC
    `);
    return result.rows.map((row) => ({
      version: typeof row.version === "string" ? Number.parseInt(row.version, 10) : row.version,
      name: row.name,
      scope: row.scope,
      checksum: row.checksum,
      upSql: typeof row.up_sql === "string" ? JSON.parse(row.up_sql) : row.up_sql,
      downSql: row.down_sql ? typeof row.down_sql === "string" ? JSON.parse(row.down_sql) : row.down_sql : [],
      appliedAt: new Date(row.applied_at)
    }));
  }
  async detectMigrationConflicts(migrations, targetBranch) {
    const conflicts = [];
    const targetSchema = await this.resolveSchemaName(targetBranch);
    const tableNames = /* @__PURE__ */ new Set();
    for (const migration of migrations) {
      for (const sql of migration.upSql) {
        const createMatch = sql.match(/CREATE TABLE\s+(?:"[^"]+"\.)?"([^"]+)"/i);
        const alterMatch = sql.match(/ALTER TABLE\s+(?:"[^"]+"\.)?"([^"]+)"/i);
        const tableName = createMatch?.[1] || alterMatch?.[1];
        if (tableName) {
          tableNames.add(tableName);
        }
      }
    }
    for (const tableName of tableNames) {
      const exists = await this.tableExists(targetSchema, tableName);
      if (exists) {
        const willBeCreated = migrations.some(
          (m) => m.upSql.some(
            (sql) => sql.match(new RegExp(`CREATE TABLE\\s+(?:"[^"]+"\\.)?["']?${tableName}["']?`, "i"))
          )
        );
        if (willBeCreated) {
          conflicts.push({
            type: "table_removed",
            description: `Table ${tableName} already exists in target branch but will be created by migration`,
            sourcePath: tableName,
            targetPath: tableName,
            resolution: ["keep_source", "keep_target", "manual"]
          });
        }
      }
    }
    return conflicts;
  }
  allConflictsResolved(conflicts, resolution) {
    if (!resolution) {
      return conflicts.length === 0;
    }
    for (const conflict of conflicts) {
      const key = conflict.sourcePath;
      if (!resolution[key]) {
        return false;
      }
    }
    return true;
  }
  async resolveSchemaName(branchName) {
    if (branchName === "main" || branchName === "public") {
      return this.mainSchema;
    }
    const result = await this.driver.query(
      `
      SELECT schema_name FROM lp_branch_metadata
      WHERE slug = $1 AND deleted_at IS NULL
    `,
      [branchName]
    );
    if (result.rows.length === 0) {
      throw new Error(`Branch '${branchName}' not found`);
    }
    return result.rows[0].schema_name;
  }
  async tableExists(schema, tableName) {
    const result = await this.driver.query(
      `
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = $1 AND table_name = $2
      ) as exists
    `,
      [schema, tableName]
    );
    return result.rows[0]?.exists ?? false;
  }
  computeChecksum(statements) {
    const { createHash: createHash5 } = __require("crypto");
    return createHash5("sha256").update(statements.join("\n")).digest("hex");
  }
  quoteIdent(identifier) {
    return `"${identifier.replace(/"/g, '""')}"`;
  }
};

// src/branch/branch-manager.ts
var BranchManager = class {
  driver;
  mainSchema;
  branchPrefix;
  defaultAutoDeleteDays;
  metadataTable;
  constructor(options) {
    this.driver = options.driver;
    this.mainSchema = options.mainSchemaName ?? "public";
    this.branchPrefix = options.branchPrefix ?? "branch_";
    this.defaultAutoDeleteDays = options.defaultAutoDeleteDays ?? 7;
    this.metadataTable = options.metadataTableName ?? "lp_branch_metadata";
  }
  async ensureMetadataTable() {
    await this.driver.execute(`
      CREATE TABLE IF NOT EXISTS ${this.quoteIdent(this.metadataTable)} (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(128) NOT NULL,
        slug VARCHAR(128) NOT NULL UNIQUE,
        schema_name VARCHAR(128) NOT NULL UNIQUE,
        parent_branch_id UUID REFERENCES ${this.quoteIdent(this.metadataTable)}(id),

        git_branch VARCHAR(256),
        pr_number INTEGER,
        pr_url TEXT,

        status VARCHAR(20) NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'protected', 'stale', 'deleting')),
        is_protected BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by VARCHAR(256),
        last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ,

        migration_count INTEGER DEFAULT 0,
        table_count INTEGER DEFAULT 0,
        storage_bytes BIGINT DEFAULT 0,

        auto_delete_days INTEGER DEFAULT 7,
        copy_data BOOLEAN DEFAULT FALSE,
        pii_masking BOOLEAN DEFAULT TRUE
      )
    `);
    await this.driver.execute(`
      CREATE INDEX IF NOT EXISTS idx_${this.metadataTable}_status
      ON ${this.quoteIdent(this.metadataTable)}(status)
    `);
    await this.driver.execute(`
      CREATE INDEX IF NOT EXISTS idx_${this.metadataTable}_parent
      ON ${this.quoteIdent(this.metadataTable)}(parent_branch_id)
    `);
    await this.driver.execute(`
      CREATE INDEX IF NOT EXISTS idx_${this.metadataTable}_pr
      ON ${this.quoteIdent(this.metadataTable)}(pr_number)
    `);
    await this.driver.execute(`
      CREATE INDEX IF NOT EXISTS idx_${this.metadataTable}_accessed
      ON ${this.quoteIdent(this.metadataTable)}(last_accessed_at)
    `);
  }
  async createBranch(options) {
    await this.ensureMetadataTable();
    const slug = this.generateSlug(options.name);
    const schemaName = `${this.branchPrefix}${slug}`;
    const existing = await this.getBranchBySlug(slug);
    if (existing) {
      throw new Error(`Branch '${slug}' already exists`);
    }
    const parentBranch = options.parentBranch ? await this.getBranchBySlug(options.parentBranch) : null;
    const parentSchema = parentBranch?.schemaName ?? this.mainSchema;
    return await this.driver.transaction(async (trx) => {
      await trx.execute(`CREATE SCHEMA IF NOT EXISTS ${this.quoteIdent(schemaName)}`);
      await this.cloneSchemaStructure(trx, parentSchema, schemaName);
      if (options.copyData) {
        await this.copyDataWithMasking(trx, parentSchema, schemaName, options.piiMasking ?? true);
      }
      const tableCount = await this.getTableCount(trx, schemaName);
      const result = await trx.query(
        `
        INSERT INTO ${this.quoteIdent(this.metadataTable)} (
          name, slug, schema_name, parent_branch_id,
          git_branch, pr_number, pr_url,
          auto_delete_days, copy_data, pii_masking, created_by, table_count
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING *
      `,
        [
          options.name,
          slug,
          schemaName,
          parentBranch?.id ?? null,
          options.gitBranch ?? null,
          options.prNumber ?? null,
          options.prUrl ?? null,
          options.autoDeleteDays ?? this.defaultAutoDeleteDays,
          options.copyData ?? false,
          options.piiMasking ?? true,
          options.createdBy ?? null,
          tableCount
        ]
      );
      return this.mapBranchRow(result.rows[0]);
    });
  }
  async getBranchBySlug(slug) {
    const result = await this.driver.query(
      `
      SELECT * FROM ${this.quoteIdent(this.metadataTable)}
      WHERE slug = $1 AND deleted_at IS NULL
    `,
      [slug]
    );
    if (result.rows.length === 0) {
      return null;
    }
    return this.mapBranchRow(result.rows[0]);
  }
  async getBranchById(id) {
    const result = await this.driver.query(
      `
      SELECT * FROM ${this.quoteIdent(this.metadataTable)}
      WHERE id = $1 AND deleted_at IS NULL
    `,
      [id]
    );
    if (result.rows.length === 0) {
      return null;
    }
    return this.mapBranchRow(result.rows[0]);
  }
  async deleteBranch(branchSlug, force = false) {
    const branch = await this.getBranchBySlug(branchSlug);
    if (!branch) {
      throw new Error(`Branch '${branchSlug}' not found`);
    }
    if (branch.isProtected && !force) {
      throw new Error(`Branch '${branchSlug}' is protected. Use force=true to delete.`);
    }
    await this.driver.transaction(async (trx) => {
      await trx.execute(
        `
        UPDATE ${this.quoteIdent(this.metadataTable)}
        SET status = 'deleting', deleted_at = NOW()
        WHERE id = $1
      `,
        [branch.id]
      );
      await trx.execute(`DROP SCHEMA IF EXISTS ${this.quoteIdent(branch.schemaName)} CASCADE`);
      await trx.execute(
        `
        DELETE FROM ${this.quoteIdent(this.metadataTable)} WHERE id = $1
      `,
        [branch.id]
      );
    });
  }
  async switchBranch(branchSlug) {
    const branch = await this.getBranchBySlug(branchSlug);
    if (!branch) {
      throw new Error(`Branch '${branchSlug}' not found`);
    }
    await this.driver.execute(
      `
      UPDATE ${this.quoteIdent(this.metadataTable)}
      SET last_accessed_at = NOW()
      WHERE id = $1
    `,
      [branch.id]
    );
    const searchPath = `${branch.schemaName}, public`;
    return {
      connectionString: this.generateConnectionString(branch),
      searchPath,
      schemaName: branch.schemaName
    };
  }
  async diffBranches(sourceBranch, targetBranch) {
    const source = await this.resolveSchemaName(sourceBranch);
    const target = await this.resolveSchemaName(targetBranch);
    const differ = new SchemaDiffer(this.driver);
    return differ.diff(source, target);
  }
  async mergeBranch(options) {
    const merger = new MigrationMerger(this.driver, {
      mainSchema: this.mainSchema,
      branchPrefix: this.branchPrefix
    });
    const result = await merger.merge(options);
    if (result.success && options.deleteSourceAfterMerge) {
      await this.deleteBranch(options.sourceBranch, true);
    }
    return result;
  }
  async listBranches(filter) {
    await this.ensureMetadataTable();
    let sql = `SELECT * FROM ${this.quoteIdent(this.metadataTable)} WHERE deleted_at IS NULL`;
    const params = [];
    let paramIndex = 1;
    if (filter?.status) {
      sql += ` AND status = $${paramIndex++}`;
      params.push(filter.status);
    }
    if (filter?.parentId) {
      sql += ` AND parent_branch_id = $${paramIndex++}`;
      params.push(filter.parentId);
    }
    if (filter?.staleDays) {
      sql += ` AND last_accessed_at < NOW() - INTERVAL '${filter.staleDays} days'`;
    }
    sql += " ORDER BY created_at DESC";
    const result = await this.driver.query(sql, params);
    return result.rows.map((row) => this.mapBranchRow(row));
  }
  async cleanupStaleBranches(options = {}) {
    await this.ensureMetadataTable();
    const maxAge = options.maxAgeDays ?? 7;
    const skipProtected = options.skipProtected ?? true;
    let sql = `
      SELECT * FROM ${this.quoteIdent(this.metadataTable)}
      WHERE deleted_at IS NULL
        AND last_accessed_at < NOW() - INTERVAL '${maxAge} days'
        AND status != 'deleting'
    `;
    if (skipProtected) {
      sql += ` AND is_protected = FALSE AND status != 'protected'`;
    }
    const result = await this.driver.query(sql);
    const deleted = [];
    const skipped = [];
    for (const row of result.rows) {
      const branch = this.mapBranchRow(row);
      if (options.dryRun) {
        deleted.push(branch.slug);
      } else {
        try {
          await this.deleteBranch(branch.slug, true);
          deleted.push(branch.slug);
        } catch (error) {
          skipped.push(`${branch.slug}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    return { deleted, skipped };
  }
  async protectBranch(branchSlug) {
    const branch = await this.getBranchBySlug(branchSlug);
    if (!branch) {
      throw new Error(`Branch '${branchSlug}' not found`);
    }
    await this.driver.execute(
      `
      UPDATE ${this.quoteIdent(this.metadataTable)}
      SET is_protected = TRUE, status = 'protected'
      WHERE id = $1
    `,
      [branch.id]
    );
  }
  async unprotectBranch(branchSlug) {
    const branch = await this.getBranchBySlug(branchSlug);
    if (!branch) {
      throw new Error(`Branch '${branchSlug}' not found`);
    }
    await this.driver.execute(
      `
      UPDATE ${this.quoteIdent(this.metadataTable)}
      SET is_protected = FALSE, status = 'active'
      WHERE id = $1
    `,
      [branch.id]
    );
  }
  async updateBranchStats(branchSlug) {
    const branch = await this.getBranchBySlug(branchSlug);
    if (!branch) {
      throw new Error(`Branch '${branchSlug}' not found`);
    }
    const tableCount = await this.getTableCount(this.driver, branch.schemaName);
    const storageResult = await this.driver.query(
      `
      SELECT COALESCE(sum(pg_total_relation_size(quote_ident(schemaname) || '.' || quote_ident(tablename)))::bigint, 0)::text as storage_bytes
      FROM pg_tables
      WHERE schemaname = $1
    `,
      [branch.schemaName]
    );
    const storageBytes = Number.parseInt(storageResult.rows[0]?.storage_bytes ?? "0", 10);
    await this.driver.execute(
      `
      UPDATE ${this.quoteIdent(this.metadataTable)}
      SET table_count = $1, storage_bytes = $2
      WHERE id = $3
    `,
      [tableCount, storageBytes, branch.id]
    );
  }
  async cloneSchemaStructure(trx, sourceSchema, targetSchema) {
    const tablesResult = await trx.query(
      `
      SELECT tablename FROM pg_tables
      WHERE schemaname = $1 AND tablename NOT LIKE 'lp_%'
    `,
      [sourceSchema]
    );
    for (const { tablename } of tablesResult.rows) {
      await trx.execute(`
        CREATE TABLE ${this.quoteIdent(targetSchema)}.${this.quoteIdent(tablename)}
        (LIKE ${this.quoteIdent(sourceSchema)}.${this.quoteIdent(tablename)}
         INCLUDING ALL)
      `);
    }
    await this.cloneSequences(trx, sourceSchema, targetSchema);
    await this.cloneViews(trx, sourceSchema, targetSchema);
  }
  async cloneSequences(trx, sourceSchema, targetSchema) {
    const sequencesResult = await trx.query(
      `
      SELECT sequence_name
      FROM information_schema.sequences
      WHERE sequence_schema = $1
    `,
      [sourceSchema]
    );
    for (const { sequence_name } of sequencesResult.rows) {
      const seqInfo = await trx.query(
        `
        SELECT start_value::text, increment_by::text, min_value::text, max_value::text, last_value::text
        FROM pg_sequences
        WHERE schemaname = $1 AND sequencename = $2
      `,
        [sourceSchema, sequence_name]
      );
      if (seqInfo.rows.length > 0) {
        const seq = seqInfo.rows[0];
        await trx.execute(`
          CREATE SEQUENCE IF NOT EXISTS ${this.quoteIdent(targetSchema)}.${this.quoteIdent(sequence_name)}
          START WITH ${seq.last_value ?? seq.start_value}
          INCREMENT BY ${seq.increment_by}
          MINVALUE ${seq.min_value}
          MAXVALUE ${seq.max_value}
        `);
      }
    }
  }
  async cloneViews(trx, sourceSchema, targetSchema) {
    const viewsResult = await trx.query(
      `
      SELECT viewname, definition
      FROM pg_views
      WHERE schemaname = $1
    `,
      [sourceSchema]
    );
    for (const { viewname, definition } of viewsResult.rows) {
      const adjustedDefinition = definition.replace(
        new RegExp(`${sourceSchema}\\.`, "g"),
        `${targetSchema}.`
      );
      await trx.execute(`
        CREATE OR REPLACE VIEW ${this.quoteIdent(targetSchema)}.${this.quoteIdent(viewname)} AS
        ${adjustedDefinition}
      `);
    }
  }
  async copyDataWithMasking(trx, sourceSchema, targetSchema, applyMasking) {
    const tablesResult = await trx.query(
      `
      SELECT tablename FROM pg_tables
      WHERE schemaname = $1 AND tablename NOT LIKE 'lp_%'
    `,
      [sourceSchema]
    );
    for (const { tablename } of tablesResult.rows) {
      if (applyMasking) {
        const columnsResult = await trx.query(
          `
          SELECT column_name, data_type
          FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2
          ORDER BY ordinal_position
        `,
          [sourceSchema, tablename]
        );
        const columnList = columnsResult.rows.map((col) => this.quoteIdent(col.column_name)).join(", ");
        const selectList = columnsResult.rows.map((col) => {
          const isPii = this.isPiiColumn(col.column_name);
          if (isPii && col.data_type === "character varying" || col.data_type === "text") {
            if (col.column_name.toLowerCase().includes("email")) {
              return `CASE WHEN ${this.quoteIdent(col.column_name)} IS NOT NULL
                THEN 'masked_' || substr(md5(${this.quoteIdent(col.column_name)}::text), 1, 8) || '@example.com'
                ELSE NULL END AS ${this.quoteIdent(col.column_name)}`;
            }
            return `CASE WHEN ${this.quoteIdent(col.column_name)} IS NOT NULL
              THEN 'masked_' || substr(md5(${this.quoteIdent(col.column_name)}::text), 1, 8)
              ELSE NULL END AS ${this.quoteIdent(col.column_name)}`;
          }
          return this.quoteIdent(col.column_name);
        }).join(", ");
        await trx.execute(`
          INSERT INTO ${this.quoteIdent(targetSchema)}.${this.quoteIdent(tablename)} (${columnList})
          SELECT ${selectList}
          FROM ${this.quoteIdent(sourceSchema)}.${this.quoteIdent(tablename)}
        `);
      } else {
        await trx.execute(`
          INSERT INTO ${this.quoteIdent(targetSchema)}.${this.quoteIdent(tablename)}
          SELECT * FROM ${this.quoteIdent(sourceSchema)}.${this.quoteIdent(tablename)}
        `);
      }
    }
  }
  isPiiColumn(columnName) {
    const piiPatterns = [
      "email",
      "phone",
      "address",
      "ssn",
      "social_security",
      "credit_card",
      "password",
      "secret",
      "token",
      "first_name",
      "last_name",
      "full_name",
      "name",
      "dob",
      "date_of_birth",
      "ip_address",
      "ip",
      "location",
      "latitude",
      "longitude"
    ];
    const lower = columnName.toLowerCase();
    return piiPatterns.some((pattern) => lower.includes(pattern));
  }
  async getTableCount(client, schemaName) {
    const result = await client.query(
      `
      SELECT COUNT(*)::text as count
      FROM pg_tables
      WHERE schemaname = $1 AND tablename NOT LIKE 'lp_%'
    `,
      [schemaName]
    );
    return Number.parseInt(result.rows[0]?.count ?? "0", 10);
  }
  generateSlug(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").substring(0, 100);
  }
  quoteIdent(identifier) {
    return `"${identifier.replace(/"/g, '""')}"`;
  }
  async resolveSchemaName(branchName) {
    if (branchName === "main" || branchName === "public") {
      return this.mainSchema;
    }
    const branch = await this.getBranchBySlug(branchName);
    if (!branch) {
      throw new Error(`Branch '${branchName}' not found`);
    }
    return branch.schemaName;
  }
  generateConnectionString(branch) {
    const baseUrl = process.env.DATABASE_URL || "";
    if (!baseUrl) {
      return `options=-c search_path=${branch.schemaName},public`;
    }
    try {
      const url = new URL(baseUrl);
      url.searchParams.set("options", `-c search_path=${branch.schemaName},public`);
      return url.toString();
    } catch {
      return `${baseUrl}?options=-c search_path=${branch.schemaName},public`;
    }
  }
  mapBranchRow(row) {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      schemaName: row.schema_name,
      parentBranchId: row.parent_branch_id,
      gitBranch: row.git_branch,
      prNumber: row.pr_number,
      prUrl: row.pr_url,
      status: row.status,
      isProtected: row.is_protected,
      createdAt: new Date(row.created_at),
      createdBy: row.created_by,
      lastAccessedAt: new Date(row.last_accessed_at),
      deletedAt: row.deleted_at ? new Date(row.deleted_at) : null,
      migrationCount: row.migration_count,
      tableCount: row.table_count,
      storageBytes: typeof row.storage_bytes === "string" ? Number.parseInt(row.storage_bytes, 10) : row.storage_bytes,
      autoDeleteDays: row.auto_delete_days,
      copyData: row.copy_data,
      piiMasking: row.pii_masking
    };
  }
};
function createBranchManager(options) {
  return new BranchManager(options);
}

// src/branch/connection-manager.ts
var ConnectionManager = class {
  driver;
  mainSchema;
  branchPrefix;
  currentSchema;
  constructor(options) {
    this.driver = options.driver;
    this.mainSchema = options.mainSchema ?? "public";
    this.branchPrefix = options.branchPrefix ?? "branch_";
    this.currentSchema = this.mainSchema;
  }
  async switchToBranch(branchSlug) {
    const schemaName = await this.getSchemaForBranch(branchSlug);
    const searchPath = `${schemaName}, public`;
    await this.driver.execute(`SET search_path TO ${searchPath}`);
    this.currentSchema = schemaName;
    await this.updateLastAccessed(branchSlug);
    return {
      schemaName,
      searchPath,
      connectionString: this.generateConnectionString(schemaName)
    };
  }
  async switchToMain() {
    const searchPath = `${this.mainSchema}, public`;
    await this.driver.execute(`SET search_path TO ${searchPath}`);
    this.currentSchema = this.mainSchema;
    return {
      schemaName: this.mainSchema,
      searchPath,
      connectionString: this.generateConnectionString(this.mainSchema)
    };
  }
  async withBranch(branchSlug, callback) {
    const schemaName = await this.getSchemaForBranch(branchSlug);
    const searchPath = `${schemaName}, public`;
    return await this.driver.transaction(async (trx) => {
      await trx.execute(`SET LOCAL search_path TO ${searchPath}`);
      return callback(trx);
    });
  }
  async withSchema(schemaName, callback) {
    const searchPath = `${schemaName}, public`;
    return await this.driver.transaction(async (trx) => {
      await trx.execute(`SET LOCAL search_path TO ${searchPath}`);
      return callback(trx);
    });
  }
  getCurrentSchema() {
    return this.currentSchema;
  }
  async getCurrentSearchPath() {
    const result = await this.driver.query("SHOW search_path");
    return result.rows[0]?.search_path ?? this.mainSchema;
  }
  async validateSchema(schemaName) {
    const result = await this.driver.query(
      `
      SELECT EXISTS (
        SELECT 1 FROM information_schema.schemata
        WHERE schema_name = $1
      ) as exists
    `,
      [schemaName]
    );
    return result.rows[0]?.exists ?? false;
  }
  async listAvailableSchemas() {
    const result = await this.driver.query(
      `
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name LIKE $1 OR schema_name = $2
      ORDER BY schema_name
    `,
      [`${this.branchPrefix}%`, this.mainSchema]
    );
    return result.rows.map((row) => row.schema_name);
  }
  generateConnectionString(schemaName) {
    const baseUrl = process.env.DATABASE_URL || "";
    if (!baseUrl) {
      return `options=-c search_path=${schemaName},public`;
    }
    try {
      const url = new URL(baseUrl);
      url.searchParams.set("options", `-c search_path=${schemaName},public`);
      return url.toString();
    } catch {
      const separator = baseUrl.includes("?") ? "&" : "?";
      return `${baseUrl}${separator}options=-c search_path=${schemaName},public`;
    }
  }
  generateEnvVars(schemaName) {
    return {
      DATABASE_URL: this.generateConnectionString(schemaName),
      DB_SCHEMA: schemaName,
      DB_SEARCH_PATH: `${schemaName}, public`
    };
  }
  async getSchemaForBranch(branchSlug) {
    if (branchSlug === "main" || branchSlug === "public") {
      return this.mainSchema;
    }
    const result = await this.driver.query(
      `
      SELECT schema_name FROM lp_branch_metadata
      WHERE slug = $1 AND deleted_at IS NULL
    `,
      [branchSlug]
    );
    if (result.rows.length === 0) {
      throw new Error(`Branch '${branchSlug}' not found`);
    }
    return result.rows[0].schema_name;
  }
  async updateLastAccessed(branchSlug) {
    await this.driver.execute(
      `
      UPDATE lp_branch_metadata
      SET last_accessed_at = NOW()
      WHERE slug = $1
    `,
      [branchSlug]
    );
  }
};
function createConnectionManager(options) {
  return new ConnectionManager(options);
}

// src/branch/cleanup-scheduler.ts
var CleanupScheduler = class {
  driver;
  intervalMs;
  defaultMaxAgeDays;
  skipProtected;
  metadataTable;
  onCleanup;
  onError;
  intervalId = null;
  isRunning = false;
  lastRun = null;
  history = [];
  constructor(options) {
    this.driver = options.driver;
    this.intervalMs = options.intervalMs ?? 24 * 60 * 60 * 1e3;
    this.defaultMaxAgeDays = options.defaultMaxAgeDays ?? 7;
    this.skipProtected = options.skipProtected ?? true;
    this.metadataTable = options.metadataTable ?? "lp_branch_metadata";
    this.onCleanup = options.onCleanup;
    this.onError = options.onError;
  }
  start() {
    if (this.intervalId) {
      return;
    }
    this.runCleanup().catch((error) => {
      if (this.onError) {
        this.onError(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.intervalId = setInterval(() => {
      this.runCleanup().catch((error) => {
        if (this.onError) {
          this.onError(error instanceof Error ? error : new Error(String(error)));
        }
      });
    }, this.intervalMs);
  }
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
  isScheduled() {
    return this.intervalId !== null;
  }
  isCurrentlyRunning() {
    return this.isRunning;
  }
  getLastRun() {
    return this.lastRun;
  }
  getHistory(limit = 10) {
    return this.history.slice(-limit);
  }
  async runCleanup(options) {
    if (this.isRunning) {
      throw new Error("Cleanup is already running");
    }
    this.isRunning = true;
    const job = {
      id: this.generateJobId(),
      startedAt: /* @__PURE__ */ new Date()
    };
    try {
      const result = await this.executeCleanup(options);
      this.recordSuccess(job, result);
      return result;
    } catch (error) {
      this.recordError(job, error);
      throw error;
    } finally {
      this.isRunning = false;
    }
  }
  async executeCleanup(options) {
    const maxAge = options?.maxAgeDays ?? this.defaultMaxAgeDays;
    const staleBranches = await this.getStaleBranches(maxAge);
    const deleted = [];
    const skipped = [];
    for (const branch of staleBranches) {
      if (options?.dryRun) {
        deleted.push(branch.slug);
        continue;
      }
      await this.tryDeleteBranch(branch, deleted, skipped);
    }
    return { deleted, skipped };
  }
  async tryDeleteBranch(branch, deleted, skipped) {
    try {
      await this.deleteBranch(branch);
      deleted.push(branch.slug);
    } catch (error) {
      skipped.push(`${branch.slug}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  recordSuccess(job, result) {
    job.completedAt = /* @__PURE__ */ new Date();
    job.result = result;
    this.lastRun = job;
    this.history.push(job);
    if (this.history.length > 100) {
      this.history = this.history.slice(-100);
    }
    if (this.onCleanup) {
      this.onCleanup(result);
    }
  }
  recordError(job, error) {
    job.completedAt = /* @__PURE__ */ new Date();
    job.error = error instanceof Error ? error.message : String(error);
    this.lastRun = job;
    this.history.push(job);
    if (this.onError) {
      this.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }
  async getStaleBranches(maxAgeDays) {
    let sql = `
      SELECT * FROM ${this.quoteIdent(this.metadataTable)}
      WHERE deleted_at IS NULL
        AND last_accessed_at < NOW() - INTERVAL '${maxAgeDays} days'
        AND status != 'deleting'
    `;
    if (this.skipProtected) {
      sql += ` AND is_protected = FALSE AND status != 'protected'`;
    }
    sql += " ORDER BY last_accessed_at ASC";
    const result = await this.driver.query(sql);
    return result.rows.map((row) => this.mapBranchRow(row));
  }
  async markAsStale(maxAgeDays) {
    let sql = `
      UPDATE ${this.quoteIdent(this.metadataTable)}
      SET status = 'stale'
      WHERE deleted_at IS NULL
        AND last_accessed_at < NOW() - INTERVAL '${maxAgeDays} days'
        AND status = 'active'
    `;
    if (this.skipProtected) {
      sql += " AND is_protected = FALSE";
    }
    const result = await this.driver.execute(sql);
    return result.rowCount;
  }
  async getUpcomingCleanups(daysAhead = 7) {
    const sql = `
      SELECT *,
        EXTRACT(DAY FROM (last_accessed_at + (auto_delete_days * INTERVAL '1 day') - NOW())) as days_until_cleanup
      FROM ${this.quoteIdent(this.metadataTable)}
      WHERE deleted_at IS NULL
        AND status != 'protected'
        AND status != 'deleting'
        AND is_protected = FALSE
        AND last_accessed_at + (auto_delete_days * INTERVAL '1 day') < NOW() + INTERVAL '${daysAhead} days'
      ORDER BY days_until_cleanup ASC
    `;
    const result = await this.driver.query(sql);
    return result.rows.map((row) => ({
      branch: this.mapBranchRow(row),
      daysUntilCleanup: Number.parseFloat(row.days_until_cleanup)
    }));
  }
  async deleteBranch(branch) {
    await this.driver.transaction(async (trx) => {
      await trx.execute(
        `
        UPDATE ${this.quoteIdent(this.metadataTable)}
        SET status = 'deleting', deleted_at = NOW()
        WHERE id = $1
      `,
        [branch.id]
      );
      await trx.execute(`DROP SCHEMA IF EXISTS ${this.quoteIdent(branch.schemaName)} CASCADE`);
      await trx.execute(
        `
        DELETE FROM ${this.quoteIdent(this.metadataTable)} WHERE id = $1
      `,
        [branch.id]
      );
    });
  }
  generateJobId() {
    return `cleanup_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }
  quoteIdent(identifier) {
    return `"${identifier.replace(/"/g, '""')}"`;
  }
  mapBranchRow(row) {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      schemaName: row.schema_name,
      parentBranchId: row.parent_branch_id,
      gitBranch: row.git_branch,
      prNumber: row.pr_number,
      prUrl: row.pr_url,
      status: row.status,
      isProtected: row.is_protected,
      createdAt: new Date(row.created_at),
      createdBy: row.created_by,
      lastAccessedAt: new Date(row.last_accessed_at),
      deletedAt: row.deleted_at ? new Date(row.deleted_at) : null,
      migrationCount: row.migration_count,
      tableCount: row.table_count,
      storageBytes: typeof row.storage_bytes === "string" ? Number.parseInt(row.storage_bytes, 10) : row.storage_bytes,
      autoDeleteDays: row.auto_delete_days,
      copyData: row.copy_data,
      piiMasking: row.pii_masking
    };
  }
};
function createCleanupScheduler(options) {
  return new CleanupScheduler(options);
}

// src/index.ts
async function createDb(options) {
  const { createDriver: createDriver2 } = await Promise.resolve().then(() => (init_driver(), driver_exports));
  const { createDbClient: createDbClient2 } = await Promise.resolve().then(() => (init_client(), client_exports));
  const driver = await createDriver2({ connectionString: options.connectionString });
  return createDbClient2(driver, {
    migrationsPath: options.migrationsPath,
    tenantColumns: options.tenantColumns,
    strictTenantMode: options.strictTenantMode
  });
}
export {
  AuthHandler,
  AuthenticationError,
  BranchManager,
  BreakingChangeError,
  CleanupScheduler,
  Column,
  ConflictError,
  ConnectionManager,
  DbClient,
  Default,
  DeleteBuilder,
  Entity,
  Index,
  InsertBuilder,
  ManyToMany,
  ManyToOne,
  MigrationCollector,
  MigrationMerger,
  MigrationRunner,
  ModuleRegistry,
  Nullable,
  OneToMany,
  OneToOne,
  PrimaryKey,
  QueryTracker,
  Repository,
  SQLCompiler,
  SchemaDiffEngine,
  SchemaDiffer,
  SchemaIntrospector,
  SchemaRegistry,
  SchemaRemoteClient,
  SchemaRemoteError,
  SchemaSyncService,
  SeedLoader,
  SeedRunner,
  SeedTracker,
  Seeder,
  SelectBuilder,
  SqlSeederAdapter,
  SyncMetadataManager,
  TableBuilder,
  TenantColumn,
  TenantContextError,
  TenantEntity,
  TenantTimestampedEntity,
  TimestampedEntity,
  TransactionContext,
  Unique,
  UpdateBuilder,
  UserCancelledError,
  WithTenantColumns,
  WithTimestamps,
  applyTenantColumns,
  applyTimestampColumns,
  columnToProperty,
  createAuthHandler,
  createBranchManager,
  createCleanupScheduler,
  createCompiler,
  createConnectionManager,
  createDb,
  createDbClient,
  createDriver,
  createHealthCheckResult,
  createMigrationCollector,
  createMigrationRunner,
  createModuleRegistry,
  createPoolMonitor,
  createRepository,
  createSchemaDiffEngine,
  createSchemaIntrospector,
  createSchemaRegistry,
  createSchemaRemoteClient,
  createSchemaSyncService,
  createSeedRunner,
  createSyncMetadataManager,
  createTimeoutPromise,
  detectDialect,
  extractSchemaFromEntities,
  extractSchemaFromEntity,
  extractTableDefinition,
  generateSchemaFromDefinition,
  generateTypes,
  getDefaultHealthCheckConfig,
  getDialect,
  getEntityColumns,
  getEntityTableName,
  isRetryableError,
  metadataStorage,
  mysqlDialect,
  postgresDialect,
  propertyToColumn,
  registerSignalHandlers,
  sqliteDialect,
  validateTenantContext,
  validateTenantContextOrWarn,
  withRetry
};
//# sourceMappingURL=index.js.map