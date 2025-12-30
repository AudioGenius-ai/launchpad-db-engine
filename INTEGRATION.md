# @launchpad/db-engine Integration Guide

This guide provides detailed documentation for integrating `@launchpad/db-engine` into your application.

## Table of Contents

1. [Quick Start](#quick-start)
2. [Multi-Tenancy Setup](#multi-tenancy-setup)
3. [Query Builder](#query-builder)
4. [Migration Authoring](#migration-authoring)
5. [ORM Entities](#orm-entities)
6. [Module System](#module-system)
7. [Type Generation](#type-generation)
8. [Troubleshooting](#troubleshooting)

---

## Quick Start

### Installation

```bash
# Core package
pnpm add @launchpad/db-engine

# Database driver (choose one)
pnpm add postgres       # PostgreSQL (recommended)
pnpm add mysql2         # MySQL
pnpm add better-sqlite3 # SQLite
```

### Basic Setup

```typescript
import { createDb } from '@launchpad/db-engine';

// Initialize database client
const db = await createDb({
  connectionString: process.env.DATABASE_URL,
  migrationsPath: './migrations',
});

// Run migrations on startup
await db.migrations.up({ scope: 'core' });

// Create tenant context (from authenticated request)
const tenantContext = {
  appId: 'my-app-id',
  organizationId: 'org-uuid-here',
};

// Query with automatic tenant scoping
const users = await db.table('users', tenantContext)
  .select('id', 'email', 'name')
  .where('status', '=', 'active')
  .execute();

// Close connection on shutdown
await db.close();
```

### Express Integration

```typescript
import express from 'express';
import { createDb, type DbClient, type TenantContext } from '@launchpad/db-engine';

const app = express();
let db: DbClient;

// Initialize on startup
app.listen(3000, async () => {
  db = await createDb({
    connectionString: process.env.DATABASE_URL,
    migrationsPath: './migrations',
  });
  await db.migrations.up({ scope: 'core' });
});

// Middleware to attach db and tenant context
app.use((req, res, next) => {
  req.db = db;
  req.tenant = {
    appId: req.headers['x-app-id'] as string,
    organizationId: req.headers['x-org-id'] as string,
  };
  next();
});

// Route example
app.get('/users', async (req, res) => {
  const users = await req.db.table('users', req.tenant)
    .select('id', 'email')
    .execute();
  res.json(users);
});
```

---

## Multi-Tenancy Setup

### How It Works

Every query is automatically scoped by two columns:
- `app_id` - Identifies the application/tenant
- `organization_id` - Identifies the organization within the tenant

The db-engine injects these values into:
- All `SELECT` queries as WHERE conditions
- All `INSERT` statements as column values
- All `UPDATE` and `DELETE` queries as WHERE conditions

### Table Structure Requirements

Tables must include tenant columns:

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id TEXT NOT NULL,                    -- Required
  organization_id UUID NOT NULL,           -- Required
  email TEXT NOT NULL,
  name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create composite index for efficient tenant queries
CREATE INDEX idx_users_tenant ON users(app_id, organization_id);
```

### Tenant Context

Always pass tenant context to queries:

```typescript
// From authenticated request
const tenant: TenantContext = {
  appId: req.user.appId,        // e.g., 'my-saas-app'
  organizationId: req.user.orgId, // e.g., 'org_123abc'
};

// All queries automatically scoped
const users = await db.table('users', tenant)
  .select('*')
  .execute();

// Generated SQL:
// SELECT * FROM "users"
// WHERE "app_id" = 'my-saas-app'
// AND "organization_id" = 'org_123abc'
```

### Cross-Tenant Queries (Admin Only)

For admin operations that need to query across tenants:

```typescript
// Use tableWithoutTenant for admin queries
const allUsers = await db.tableWithoutTenant('users')
  .select('id', 'email', 'app_id')
  .execute();
```

**Warning**: Only use `tableWithoutTenant` for admin operations. Never expose this to tenant-scoped requests.

### Transactions with Tenancy

```typescript
await db.transaction(tenant, async (trx) => {
  // All queries in transaction are tenant-scoped
  const org = await trx.table('organizations')
    .insert()
    .values({ name: 'New Org' })
    .returning('id')
    .execute();

  await trx.table('users')
    .insert()
    .values({ email: 'admin@neworg.com' })
    .execute();
});
```

---

## Query Builder

### SELECT Queries

```typescript
const tenant = { appId: 'app-1', organizationId: 'org-1' };

// Basic select
const users = await db.table('users', tenant)
  .select('id', 'email', 'name')
  .execute();

// Select all columns
const allColumns = await db.table('users', tenant)
  .select('*')
  .execute();

// With conditions
const activeUsers = await db.table('users', tenant)
  .select('id', 'email')
  .where('status', '=', 'active')
  .where('role', '=', 'admin')
  .execute();

// Multiple condition types
const filteredUsers = await db.table('users', tenant)
  .select('*')
  .where('created_at', '>', new Date('2024-01-01'))
  .where('email', 'LIKE', '%@company.com')
  .whereIn('status', ['active', 'pending'])
  .whereNotIn('role', ['banned', 'suspended'])
  .whereNull('deleted_at')
  .whereNotNull('verified_at')
  .execute();

// Ordering
const sorted = await db.table('users', tenant)
  .select('*')
  .orderBy('created_at', 'desc')
  .orderBy('name', 'asc')
  .execute();

// Pagination
const page2 = await db.table('users', tenant)
  .select('*')
  .orderBy('id', 'asc')
  .limit(20)
  .offset(20)
  .execute();

// Count
const count = await db.table('users', tenant)
  .count()
  .where('status', '=', 'active')
  .execute();
```

### INSERT Queries

```typescript
// Single insert
await db.table('users', tenant)
  .insert()
  .values({
    email: 'user@example.com',
    name: 'John Doe',
  })
  .execute();
// app_id and organization_id are automatically added

// Insert with returning (PostgreSQL)
const [newUser] = await db.table('users', tenant)
  .insert()
  .values({ email: 'new@example.com' })
  .returning('id', 'email')
  .execute();

// Bulk insert
await db.table('users', tenant)
  .insert()
  .values([
    { email: 'user1@example.com', name: 'User 1' },
    { email: 'user2@example.com', name: 'User 2' },
    { email: 'user3@example.com', name: 'User 3' },
  ])
  .execute();
```

### UPDATE Queries

```typescript
// Update by condition
await db.table('users', tenant)
  .update()
  .set({ status: 'inactive' })
  .where('last_login', '<', new Date('2023-01-01'))
  .execute();

// Update multiple fields
await db.table('users', tenant)
  .update()
  .set({
    name: 'Updated Name',
    updated_at: new Date(),
  })
  .where('id', '=', userId)
  .execute();

// Update with returning (PostgreSQL)
const [updated] = await db.table('users', tenant)
  .update()
  .set({ status: 'verified' })
  .where('id', '=', userId)
  .returning('id', 'status', 'updated_at')
  .execute();
```

### DELETE Queries

```typescript
// Soft delete (recommended)
await db.table('users', tenant)
  .update()
  .set({ deleted_at: new Date() })
  .where('id', '=', userId)
  .execute();

// Hard delete
await db.table('users', tenant)
  .delete()
  .where('id', '=', userId)
  .execute();

// Bulk delete
await db.table('sessions', tenant)
  .delete()
  .where('expires_at', '<', new Date())
  .execute();
```

### JOIN Queries

```typescript
// Inner join
const usersWithOrgs = await db.table('users', tenant)
  .select('users.id', 'users.email', 'organizations.name as org_name')
  .join('organizations', 'users.organization_id', '=', 'organizations.id')
  .execute();

// Left join
const usersWithProfiles = await db.table('users', tenant)
  .select('users.*', 'profiles.avatar_url')
  .leftJoin('profiles', 'users.id', '=', 'profiles.user_id')
  .execute();

// Multiple joins
const orderDetails = await db.table('orders', tenant)
  .select(
    'orders.id',
    'users.email',
    'products.name as product_name'
  )
  .join('users', 'orders.user_id', '=', 'users.id')
  .join('order_items', 'orders.id', '=', 'order_items.order_id')
  .join('products', 'order_items.product_id', '=', 'products.id')
  .where('orders.status', '=', 'completed')
  .execute();
```

### Raw Queries

```typescript
// Raw query with tenant context
const results = await db.rawWithTenant<User>(
  tenant,
  `SELECT * FROM users WHERE email = $1`,
  ['user@example.com']
);

// Raw query without tenant (admin only)
const allResults = await db.raw<User>(
  `SELECT * FROM users WHERE app_id = $1`,
  ['admin-app']
);

// Execute (no results)
await db.execute(
  `TRUNCATE TABLE sessions CASCADE`
);
```

---

## Migration Authoring

### File Naming Convention

```
{timestamp}__{description}.sql

Examples:
20240115120000__create_users_table.sql
20240115120001__add_email_index.sql
20240116000000__add_profiles_table.sql
```

### Directory Structure

```
migrations/
├── core/                              # Shared platform migrations
│   ├── 20240101000000__initial.sql
│   └── 20240102000000__add_orgs.sql
└── templates/                         # Template-specific migrations
    ├── crm/
    │   ├── 20240201000000__contacts.sql
    │   └── 20240202000000__deals.sql
    └── ecommerce/
        ├── 20240301000000__products.sql
        └── 20240302000000__orders.sql
```

### Migration File Format

```sql
-- migrations/core/20240115120000__create_users_table.sql

-- up
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id TEXT NOT NULL,
  organization_id UUID NOT NULL,
  email TEXT NOT NULL,
  name TEXT,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_users_email_tenant
  ON users(app_id, organization_id, email);
CREATE INDEX idx_users_tenant
  ON users(app_id, organization_id);

-- down
DROP TABLE IF EXISTS users CASCADE;
```

### Best Practices

**1. Always include tenant columns:**
```sql
CREATE TABLE your_table (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id TEXT NOT NULL,            -- Always required
  organization_id UUID NOT NULL,   -- Always required
  -- your columns here
);
```

**2. Create tenant composite indexes:**
```sql
-- For efficient tenant-scoped queries
CREATE INDEX idx_tablename_tenant ON tablename(app_id, organization_id);

-- For unique constraints within tenant
CREATE UNIQUE INDEX idx_tablename_unique_field_tenant
  ON tablename(app_id, organization_id, unique_field);
```

**3. Use conditional creates for safety:**
```sql
-- up
CREATE TABLE IF NOT EXISTS users (...);
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(...);

-- down
DROP TABLE IF EXISTS users CASCADE;
DROP INDEX IF EXISTS idx_users_tenant;
```

**4. Add foreign keys with proper cascades:**
```sql
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id TEXT NOT NULL,
  organization_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- ...
);
```

### Running Migrations

```bash
# CLI commands
launchpad-db migrate:up                           # Run all pending
launchpad-db migrate:up --scope core              # Core only
launchpad-db migrate:up --scope template --key crm # Template specific
launchpad-db migrate:down --steps 1               # Rollback last
launchpad-db migrate:status                       # Show status
launchpad-db migrate:verify                       # Verify checksums
```

```typescript
// Programmatic API
await db.migrations.up({ scope: 'core' });
await db.migrations.up({ scope: 'template', templateKey: 'crm' });
await db.migrations.down({ steps: 1 });

const status = await db.migrations.status();
console.log(`Applied: ${status.applied.length}`);
console.log(`Pending: ${status.pending.length}`);
```

---

## ORM Entities

### Basic Entity Definition

```typescript
import {
  Entity,
  Column,
  PrimaryKey,
  TenantColumn,
  Unique,
  Default,
  Index,
} from '@launchpad/db-engine/orm';

@Entity('users')
@Index({ columns: ['app_id', 'organization_id'] })
export class User {
  @PrimaryKey()
  @Column('uuid')
  @Default('gen_random_uuid()')
  id!: string;

  @TenantColumn()
  @Column('string')
  app_id!: string;

  @TenantColumn()
  @Column('uuid')
  organization_id!: string;

  @Column('string')
  @Unique()
  email!: string;

  @Column('string', { nullable: true })
  name?: string;

  @Column('string')
  @Default("'pending'")
  status!: string;

  @Column('datetime')
  @Default('NOW()')
  created_at!: Date;
}
```

### Using Base Classes

```typescript
import {
  Entity,
  Column,
  PrimaryKey,
  TenantTimestampedEntity,
  WithTenantColumns,
  WithTimestamps,
} from '@launchpad/db-engine/orm';

// Option 1: Extend base class
@Entity('products')
export class Product extends TenantTimestampedEntity {
  @PrimaryKey()
  @Column('uuid')
  id!: string;

  @Column('string')
  name!: string;

  @Column('decimal')
  price!: number;
}

// Option 2: Use decorators
@Entity('orders')
@WithTenantColumns()
@WithTimestamps()
export class Order {
  @PrimaryKey()
  @Column('uuid')
  id!: string;

  @Column('string')
  status!: string;
}
```

### Relations

```typescript
import {
  Entity,
  Column,
  Nullable,
  Unique,
  ManyToOne,
  OneToMany,
  OneToOne,
  ManyToMany,
} from '@launchpad/db-engine/orm';

@Entity('posts')
export class Post extends TenantTimestampedEntity {
  @PrimaryKey()
  @Column('uuid')
  id!: string;

  @Column('string')
  title!: string;

  @Column('uuid')
  author_id!: string;

  @Column('string')
  @Nullable()
  subtitle?: string;

  @ManyToOne(() => User)
  author!: User;

  @OneToMany(() => Comment, 'post')
  comments!: Comment[];

  @ManyToMany(() => Tag, { joinTable: 'post_tags' })
  tags!: Tag[];

  @OneToOne(() => PostMeta, { foreignKey: 'post_id' })
  meta?: PostMeta;
}

@Entity('post_meta')
export class PostMeta extends TenantTimestampedEntity {
  @PrimaryKey()
  @Column('uuid')
  id!: string;

  @Column('uuid')
  @Unique()
  post_id!: string;

  @Column('json')
  seo_data!: Record<string, unknown>;

  @OneToOne(() => Post)
  post!: Post;
}

@Entity('comments')
export class Comment extends TenantTimestampedEntity {
  @PrimaryKey()
  @Column('uuid')
  id!: string;

  @Column('text')
  content!: string;

  @Column('uuid')
  post_id!: string;

  @ManyToOne(() => Post, { foreignKey: 'post_id' })
  post!: Post;
}
```

### Schema Extraction

Extract database schema definitions from entity classes for migrations or documentation:

```typescript
import {
  extractSchemaFromEntities,
  extractSchemaFromEntity,
  getEntityTableName,
  getEntityColumns,
} from '@launchpad/db-engine/orm';

// Extract schema from multiple entities
const schema = extractSchemaFromEntities([User, Post, Comment]);
// Returns: { users: {...}, posts: {...}, comments: {...} }

// Extract from a single entity
const userSchema = extractSchemaFromEntity(User);
// Returns: { tableName: 'users', columns: [...], indexes: [...] }

// Get table name from entity class
const tableName = getEntityTableName(User); // 'users'

// Get all column definitions
const columns = getEntityColumns(User);
// Returns: [{ name: 'id', type: 'uuid', primaryKey: true }, ...]
```

Use these utilities to:
- Generate migration files from entity definitions
- Create database documentation
- Validate entity schemas
- Build admin interfaces

### Column Types

| TypeScript | Column Type | PostgreSQL | MySQL | SQLite |
|------------|-------------|------------|-------|--------|
| `string` | `'string'` | TEXT | VARCHAR(255) | TEXT |
| `string` | `'text'` | TEXT | TEXT | TEXT |
| `number` | `'integer'` | INTEGER | INT | INTEGER |
| `number` | `'bigint'` | BIGINT | BIGINT | INTEGER |
| `number` | `'decimal'` | DECIMAL | DECIMAL | REAL |
| `number` | `'float'` | FLOAT | FLOAT | REAL |
| `boolean` | `'boolean'` | BOOLEAN | TINYINT(1) | INTEGER |
| `Date` | `'datetime'` | TIMESTAMPTZ | DATETIME | TEXT |
| `Date` | `'date'` | DATE | DATE | TEXT |
| `string` | `'uuid'` | UUID | CHAR(36) | TEXT |
| `object` | `'json'` | JSONB | JSON | TEXT |

### Using Entities with Repository

```typescript
import { Repository } from '@launchpad/db-engine/orm';

const userRepo = new Repository(User, db);

// Find all
const users = await userRepo.find(tenant, {
  where: { status: 'active' },
  orderBy: { created_at: 'desc' },
  limit: 10,
});

// Find one
const user = await userRepo.findOne(tenant, {
  where: { id: userId },
});

// Create
const newUser = await userRepo.create(tenant, {
  email: 'new@example.com',
  name: 'New User',
});

// Update
await userRepo.update(tenant, userId, {
  status: 'verified',
});

// Delete
await userRepo.delete(tenant, userId);
```

---

## Module System

The module system allows you to organize migrations by feature modules, track registered modules, and collect migrations from multiple sources.

### Module Definition

```typescript
interface ModuleDefinition {
  name: string;           // Unique module identifier (e.g., 'auth', 'payments')
  displayName: string;    // Human-readable name
  description?: string;   // Module description
  version: string;        // Semantic version
  dependencies?: string[]; // Other modules this depends on
  migrationPrefix: string; // Unique prefix for migration ordering
}
```

### Module Registry

Register and track modules in the database:

```typescript
import { createModuleRegistry } from '@launchpad/db-engine/modules';

const registry = createModuleRegistry(driver);

// Register a module
await registry.register({
  name: 'payments',
  displayName: 'Payments Module',
  description: 'Handles payment processing and subscriptions',
  version: '1.0.0',
  dependencies: ['auth', 'users'],
  migrationPrefix: 'payments',
});

// List all registered modules
const modules = await registry.list();

// Get a specific module
const paymentsModule = await registry.get('payments');

// Unregister a module
await registry.unregister('payments');
```

### Migration Collector

Collect migrations from multiple module directories:

```typescript
import { createMigrationCollector } from '@launchpad/db-engine/modules';

const collector = createMigrationCollector();

// Discover modules from a directory structure
// modules/
//   auth/
//     20240101000000__create_users.sql
//   payments/
//     20240201000000__create_subscriptions.sql
const sources = await collector.discoverFromDirectory('./modules');

// Collect all migrations ordered by version
const migrations = await collector.collect(sources, { scope: 'core' });
```

### Module Migration Structure

```
modules/
├── auth/
│   ├── 20240101000000__create_users.sql
│   └── 20240102000000__add_sessions.sql
├── payments/
│   ├── 20240201000000__create_subscriptions.sql
│   └── 20240202000000__add_invoices.sql
└── notifications/
    └── 20240301000000__create_notifications.sql
```

---

## Type Generation

### CLI Usage

```bash
# Generate types from registered schemas
launchpad-db types:generate --output ./src/types/db.ts

# Generate for specific app
launchpad-db types:generate --app-id my-app --output ./src/types/db.ts

# Watch mode
launchpad-db types:generate --output ./src/types/db.ts --watch
```

### Generated Output

```typescript
// ./src/types/db.ts (generated)

export namespace Users {
  export interface Row {
    id: string;
    app_id: string;
    organization_id: string;
    email: string;
    name: string | null;
    status: string;
    created_at: Date;
    updated_at: Date;
  }

  export interface Insert {
    email: string;
    name?: string | null;
    status?: string;
  }

  export interface Update {
    email?: string;
    name?: string | null;
    status?: string;
  }
}

export namespace Orders {
  export interface Row {
    id: string;
    app_id: string;
    organization_id: string;
    user_id: string;
    total: number;
    status: string;
    created_at: Date;
  }

  export interface Insert {
    user_id: string;
    total: number;
    status?: string;
  }
}

export type TableName = 'users' | 'orders';
```

### Using Generated Types

```typescript
import type { Users, Orders } from './types/db';

// Type-safe queries
const users = await db.table<Users.Row>('users', tenant)
  .select('id', 'email', 'name')
  .execute();

// Type-safe inserts
const newUser: Users.Insert = {
  email: 'user@example.com',
  name: 'John Doe',
};

await db.table('users', tenant)
  .insert()
  .values(newUser)
  .execute();
```

---

## Troubleshooting

### Common Issues

#### 1. "Tenant context required"

**Problem:**
```
Error: Tenant context required for table 'users'
```

**Solution:**
Pass tenant context to all queries:
```typescript
// Wrong
const users = await db.table('users').select('*').execute();

// Correct
const users = await db.table('users', tenant).select('*').execute();
```

#### 2. "Missing tenant columns"

**Problem:**
```
Error: Table 'products' missing required tenant columns
```

**Solution:**
Add tenant columns to your migration:
```sql
ALTER TABLE products
ADD COLUMN app_id TEXT NOT NULL,
ADD COLUMN organization_id UUID NOT NULL;
```

#### 3. "Connection pool exhausted"

**Problem:**
```
Error: Connection pool exhausted
```

**Solution:**
- Increase pool size in connection string
- Ensure connections are properly released
- Check for long-running queries

```typescript
const db = await createDb({
  connectionString: `${DATABASE_URL}?pool_max=20`,
});
```

#### 4. "Migration checksum mismatch"

**Problem:**
```
Error: Migration checksum mismatch for '20240101000000__initial.sql'
```

**Solution:**
- Never modify applied migrations in production
- For development, reset and re-run:
```bash
launchpad-db migrate:down --all
launchpad-db migrate:up
```

#### 5. "SQLite column alteration not supported"

**Problem:**
```
Error: SQLite does not support ALTER COLUMN
```

**Solution:**
Use table recreation pattern:
```sql
-- up
CREATE TABLE users_new (...);
INSERT INTO users_new SELECT ... FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

-- down
-- reverse the process
```

### Performance Tips

**1. Use composite indexes for tenant queries:**
```sql
CREATE INDEX idx_orders_tenant_status
  ON orders(app_id, organization_id, status);
```

**2. Batch inserts for bulk operations:**
```typescript
// Instead of loop inserts
await db.table('items', tenant)
  .insert()
  .values(items) // Array of items
  .execute();
```

**3. Use transactions for related operations:**
```typescript
await db.transaction(tenant, async (trx) => {
  // Multiple queries in single transaction
});
```

**4. Select only needed columns:**
```typescript
// Instead of SELECT *
await db.table('users', tenant)
  .select('id', 'email') // Only what you need
  .execute();
```

### Debug Mode

Enable query logging:

```typescript
const db = await createDb({
  connectionString: process.env.DATABASE_URL,
  debug: true, // Logs all queries
});
```

Or set environment variable:
```bash
DEBUG=launchpad:db:* node app.js
```
