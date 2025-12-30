# @launchpad/db-engine Knowledge Base

Auto-generated documentation of APIs, utilities, patterns, and architectural decisions.

## API Endpoints

N/A - This is a database engine library, not an HTTP service.

## Driver Interface

### Core Driver Methods

| Method | Description | Returns |
|--------|-------------|---------|
| `query<T>(sql, params?)` | Execute SQL query and return rows | `Promise<QueryResult<T>>` |
| `execute(sql, params?)` | Execute SQL statement (INSERT/UPDATE/DELETE) | `Promise<{ rowCount: number }>` |
| `transaction<T>(fn)` | Execute operations in a transaction | `Promise<T>` |
| `close()` | Close all connections | `Promise<void>` |

### Health Check Methods (TASK-357)

| Method | Description | Returns |
|--------|-------------|---------|
| `healthCheck()` | Perform immediate health check ping | `Promise<HealthCheckResult>` |
| `getPoolStats()` | Get current connection pool statistics | `PoolStats` |
| `isHealthy()` | Check if last health check passed | `boolean` |
| `startHealthChecks()` | Start periodic health check interval | `void` |
| `stopHealthChecks()` | Stop periodic health checks | `void` |

## Utilities

### Health Check Utilities (`src/driver/health.ts`)

| Function | Purpose | Parameters |
|----------|---------|------------|
| `createHealthCheckResult(healthy, latencyMs, error?)` | Factory for HealthCheckResult objects | `boolean, number, string?` |
| `getDefaultHealthCheckConfig(overrides?)` | Get default health check config with optional overrides | `Partial<HealthCheckConfig>?` |

### Retry Utilities (`src/driver/retry.ts`)

| Function | Purpose | Parameters |
|----------|---------|------------|
| `isRetryableError(error, customErrors?)` | Check if error is retryable (connection errors) | `unknown, string[]?` |
| `withRetry<T>(operation, config?)` | Execute operation with exponential backoff retry | `() => Promise<T>, RetryConfig?` |
| `createTimeoutPromise<T>(timeoutMs)` | Create a promise that rejects after timeout | `number` |

### Pool Monitor (`src/driver/pool-monitor.ts`)

| Function | Purpose | Parameters |
|----------|---------|------------|
| `createPoolMonitor(getStats, config?)` | Create pool exhaustion monitor | `() => PoolStats, PoolMonitorConfig?` |

## Types

### HealthCheckResult
```typescript
interface HealthCheckResult {
  healthy: boolean;
  latencyMs: number;
  lastCheckedAt: Date;
  error?: string;
}
```

### PoolStats
```typescript
interface PoolStats {
  totalConnections: number;
  activeConnections: number;
  idleConnections: number;
  waitingRequests: number;
  maxConnections: number;
}
```

### HealthCheckConfig
```typescript
interface HealthCheckConfig {
  enabled?: boolean;           // Default: false
  intervalMs?: number;         // Default: 30000 (30s)
  timeoutMs?: number;          // Default: 5000 (5s)
  onHealthChange?: (healthy: boolean, result: HealthCheckResult) => void;
}
```

### PoolMonitorConfig
```typescript
interface PoolMonitorConfig {
  warningThreshold?: number;   // Default: 0.8 (80%)
  criticalThreshold?: number;  // Default: 0.95 (95%)
  checkIntervalMs?: number;    // Default: 10000 (10s)
  onWarning?: (stats: PoolStats) => void;
  onCritical?: (stats: PoolStats) => void;
  onRecovery?: (stats: PoolStats) => void;
}
```

### RetryConfig
```typescript
interface RetryConfig {
  maxRetries?: number;         // Default: 3
  baseDelayMs?: number;        // Default: 100
  maxDelayMs?: number;         // Default: 5000
  retryableErrors?: string[];  // Additional error codes to retry
}
```

## Patterns

### Connection Health Check Pattern
All drivers implement health checks using a simple ping query:
- **PostgreSQL**: `SELECT 1` via postgres.js
- **MySQL**: `pool.getConnection()` + `connection.ping()`
- **SQLite**: `db.prepare('SELECT 1').get()` (synchronous)

Health checks are opt-in via `config.healthCheck.enabled = true`.

### Retry with Exponential Backoff
Connection errors automatically retry with exponential backoff and jitter:
```typescript
const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
const jitter = Math.random() * delay * 0.1;
```

Default retryable errors include:
- Network: `ECONNREFUSED`, `ETIMEDOUT`, `ECONNRESET`, `EPIPE`, `ENOTCONN`
- PostgreSQL: `57P01`, `57P02`, `57P03` (admin shutdown, crash, cannot connect)
- MySQL: `PROTOCOL_CONNECTION_LOST`, `ER_CON_COUNT_ERROR`

### Pool Exhaustion Detection
Pool monitor tracks utilization and logs warnings/critical alerts:
- **Warning**: 80% pool utilization
- **Critical**: 95% pool utilization
- **Recovery**: Logged when utilization drops below warning threshold

## Architecture Decisions

### ADR-001: Opt-in Health Checks
**Context**: Health checks add overhead and may not be needed for all use cases.
**Decision**: Health checks are disabled by default (`enabled: false`).
**Consequence**: Users must explicitly enable health checks in config.

### ADR-002: Backward Compatible Driver Interface
**Context**: Adding health check methods would break existing driver implementations.
**Decision**: All new methods are required on the Driver interface but have sensible defaults.
**Consequence**: Existing code works without changes; health features require explicit usage.

### ADR-003: Driver-Specific Pool Stats
**Context**: Each database driver library exposes pool metrics differently.
**Decision**: Each driver implements `getPoolStats()` using library-specific APIs.
**Consequence**: PostgreSQL (postgres.js) has limited pool visibility compared to MySQL (mysql2).

## Recent Changes

- **[TASK-357]**: Implemented connection pool health checks for all database drivers
  - Added `healthCheck()`, `getPoolStats()`, `isHealthy()`, `startHealthChecks()`, `stopHealthChecks()` to Driver interface
  - Created health check utilities (`src/driver/health.ts`)
  - Created retry logic with exponential backoff (`src/driver/retry.ts`)
  - Created pool exhaustion monitor (`src/driver/pool-monitor.ts`)
  - Added 45 unit tests (12 health, 18 pool-monitor, 15 retry)
  - PostgreSQL, MySQL, SQLite drivers all implement health check interface

- **[TASK-273]**: Implemented seed data management system
- **[TASK-140]**: Added MongoDB driver support
- **[TASK-226]**: Implemented database branching for preview environments
