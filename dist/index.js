var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/driver/postgresql.ts
import postgres from "postgres";
function createPostgresDriver(config) {
  const sql = postgres(config.connectionString, {
    max: config.max ?? 20,
    idle_timeout: config.idleTimeout ?? 30,
    connect_timeout: config.connectTimeout ?? 10,
    prepare: true
  });
  return {
    dialect: "postgresql",
    connectionString: config.connectionString,
    async query(queryText, params = []) {
      const result = await sql.unsafe(queryText, params);
      return {
        rows: result,
        rowCount: result.length
      };
    },
    async execute(queryText, params = []) {
      const result = await sql.unsafe(queryText, params);
      return { rowCount: result.count ?? 0 };
    },
    async transaction(fn) {
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
    },
    async close() {
      await sql.end();
    }
  };
}
var init_postgresql = __esm({
  "src/driver/postgresql.ts"() {
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
  return {
    dialect: "mysql",
    connectionString: config.connectionString,
    async query(queryText, params = []) {
      const [rows] = await pool.execute(queryText, params);
      const resultRows = Array.isArray(rows) ? rows : [];
      return {
        rows: resultRows,
        rowCount: resultRows.length
      };
    },
    async execute(queryText, params = []) {
      const [result] = await pool.execute(queryText, params);
      const affectedRows = result.affectedRows ?? 0;
      return { rowCount: affectedRows };
    },
    async transaction(fn) {
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
      }
    },
    async close() {
      await pool.end();
    }
  };
}
var init_mysql = __esm({
  "src/driver/mysql.ts"() {
    "use strict";
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
  return {
    dialect: "sqlite",
    connectionString: config.connectionString,
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
      const result = stmt.run(...params);
      return { rowCount: result.changes };
    },
    async transaction(fn) {
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
      }
    },
    async close() {
      db.close();
    }
  };
}
var init_sqlite = __esm({
  "src/driver/sqlite.ts"() {
    "use strict";
  }
});

// src/driver/index.ts
var driver_exports = {};
__export(driver_exports, {
  createDriver: () => createDriver,
  detectDialect: () => detectDialect
});
function detectDialect(connectionString) {
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
    default:
      throw new Error(`Unsupported dialect: ${dialect}`);
  }
}
var init_driver = __esm({
  "src/driver/index.ts"() {
    "use strict";
    init_postgresql();
  }
});

// src/compiler/index.ts
function createCompiler(options) {
  return new SQLCompiler(options);
}
var DEFAULT_TENANT_COLUMNS, SQLCompiler;
var init_compiler = __esm({
  "src/compiler/index.ts"() {
    "use strict";
    DEFAULT_TENANT_COLUMNS = {
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
        this.tenantColumns = options.tenantColumns ?? DEFAULT_TENANT_COLUMNS;
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
        return ast.joins.map((join3) => {
          const alias = join3.alias ? ` AS ${this.quoteIdentifier(join3.alias)}` : "";
          return ` ${join3.type} JOIN ${this.quoteIdentifier(join3.table)}${alias} ON ${this.quoteIdentifier(join3.on.leftColumn)} = ${this.quoteIdentifier(join3.on.rightColumn)}`;
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
var SelectBuilder, InsertBuilder, UpdateBuilder, DeleteBuilder, TableBuilder;
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

// src/migrations/dialects/index.ts
function getDialect(name) {
  switch (name) {
    case "postgresql":
      return postgresDialect;
    case "mysql":
      return mysqlDialect;
    case "sqlite":
      return sqliteDialect;
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
        this.compiler = new SQLCompiler({
          dialect: driver.dialect,
          injectTenant: true,
          tenantColumns: options.tenantColumns
        });
        if (options.migrationsPath) {
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
        return new TableBuilder(this.driver, this.compiler, name, ctx, true);
      }
      tableWithoutTenant(name) {
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
  Column,
  DbClient,
  Default,
  DeleteBuilder,
  Entity,
  Index,
  InsertBuilder,
  ManyToMany,
  ManyToOne,
  MigrationCollector,
  MigrationRunner,
  ModuleRegistry,
  Nullable,
  OneToMany,
  OneToOne,
  PrimaryKey,
  Repository,
  SQLCompiler,
  SchemaRegistry,
  SelectBuilder,
  TableBuilder,
  TenantColumn,
  TenantContextError,
  TenantEntity,
  TenantTimestampedEntity,
  TimestampedEntity,
  TransactionContext,
  Unique,
  UpdateBuilder,
  WithTenantColumns,
  WithTimestamps,
  applyTenantColumns,
  applyTimestampColumns,
  columnToProperty,
  createCompiler,
  createDb,
  createDbClient,
  createDriver,
  createMigrationCollector,
  createMigrationRunner,
  createModuleRegistry,
  createRepository,
  createSchemaRegistry,
  detectDialect,
  extractSchemaFromEntities,
  extractSchemaFromEntity,
  extractTableDefinition,
  generateSchemaFromDefinition,
  generateTypes,
  getDialect,
  getEntityColumns,
  getEntityTableName,
  metadataStorage,
  mysqlDialect,
  postgresDialect,
  propertyToColumn,
  sqliteDialect,
  validateTenantContext,
  validateTenantContextOrWarn
};
//# sourceMappingURL=index.js.map