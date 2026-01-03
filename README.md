# @launchpad/db-engine

[![CI](https://github.com/AudioGenius-ai/launchpad-db-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/AudioGenius-ai/launchpad-db-engine/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/AudioGenius-ai/launchpad-db-engine/graph/badge.svg)](https://codecov.io/gh/AudioGenius-ai/launchpad-db-engine)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Custom database engine with built-in multi-tenancy, migrations, and type generation. Built for BaaS (Backend-as-a-Service) platforms.

**191 tests** (173 unit + 18 integration) | Node.js 18+ | PostgreSQL, MySQL, SQLite

## Features

- **Multi-Database Support**: PostgreSQL, MySQL, SQLite
- **Built-in Multi-Tenancy**: Every query automatically scoped by `app_id` and `organization_id`
- **Custom Migration System**: Unified migrations for core and template tables
- **Dynamic Schema Registry**: Register schemas at runtime
- **Type Generation**: Generate TypeScript types from registered schemas
- **Query Builder**: Fluent, type-safe API

## Installation

```bash
pnpm add @launchpad/db-engine

# PostgreSQL (default)
pnpm add postgres

# MySQL (optional)
pnpm add mysql2

# SQLite (optional)
pnpm add better-sqlite3
```

## Quick Start

```typescript
import { createDb } from '@launchpad/db-engine';

// Create database client
const db = await createDb({
  connectionString: process.env.DATABASE_URL!,
  migrationsPath: './migrations',
});

// Tenant context (from authenticated request)
const ctx = {
  appId: 'my-app',
  organizationId: 'org_123',
};

// Query with automatic tenant injection
const users = await db.table('users', ctx)
  .select('id', 'email', 'name')
  .where('status', '=', 'active')
  .orderBy('created_at', 'desc')
  .limit(10)
  .execute();

// Insert with automatic tenant columns
await db.table('users', ctx)
  .insert()
  .values({
    email: 'john@example.com',
    name: 'John Doe',
  })
  .execute();

// Transaction
await db.transaction(ctx, async (trx) => {
  const org = await trx.table('organizations')
    .insert()
    .values({ name: 'Acme Inc' })
    .returning('id')
    .execute();

  await trx.table('users')
    .insert()
    .values({
      email: 'admin@acme.com',
      organization_id: org[0].id,
    })
    .execute();
});

// Close connection
await db.close();
```

## Migrations

### File Structure

```
migrations/
├── core/
│   ├── 20240101000000__initial_schema.sql
│   └── 20240102000000__add_organizations.sql
└── templates/
    └── crm/
        ├── 20240201000000__initial_crm.sql
        └── 20240202000000__add_contacts.sql
```

### Migration File Format

```sql
-- migrations/core/20240101000000__initial_schema.sql

-- up
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id TEXT NOT NULL,
  organization_id UUID NOT NULL,
  email TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_tenant ON users(app_id, organization_id);

-- down
DROP TABLE IF EXISTS users;
```

### CLI Commands

```bash
# Run migrations
launchpad-db migrate:up
launchpad-db migrate:up --scope template --template-key crm

# Rollback
launchpad-db migrate:down --steps 1

# Status
launchpad-db migrate:status

# Create migration
launchpad-db migrate:create --name add_payments --scope core

# Verify checksums
launchpad-db migrate:verify
```

### Programmatic API

```typescript
// Run migrations on startup
await db.migrations.up({ scope: 'core' });

// Check status
const status = await db.migrations.status();
console.log(`Applied: ${status.applied.length}, Pending: ${status.pending.length}`);
```

## Dynamic Schema Registration

Templates can register their schemas at runtime:

```typescript
// Define schema
const crmSchema = {
  tables: {
    contacts: {
      columns: {
        id: { type: 'uuid', primaryKey: true, default: 'gen_random_uuid()' },
        app_id: { type: 'string', tenant: true },
        organization_id: { type: 'uuid', tenant: true },
        first_name: { type: 'string' },
        last_name: { type: 'string' },
        email: { type: 'string', unique: true },
        created_at: { type: 'datetime', default: 'now()' },
      },
      indexes: [
        { columns: ['app_id', 'organization_id'] },
      ],
    },
  },
};

// Register schema
await db.schema.register({
  appId: 'crm-app',
  schemaName: 'crm',
  version: '1.0.0',
  schema: crmSchema,
});
```

## Type Generation

Generate TypeScript types from registered schemas:

```bash
# Generate TypeScript interfaces
launchpad-db types:generate --output ./src/types.ts

# Generate with Zod validation schemas
launchpad-db types:generate --output ./src/types.ts --zod

# Custom type suffixes
launchpad-db types:generate --insert-suffix Create --update-suffix Patch

# Skip Insert or Update types
launchpad-db types:generate --no-insert
launchpad-db types:generate --no-update
```

Generated output:

```typescript
export namespace Crm {
  // Row type - all columns
  export interface Contacts {
    id: string;
    app_id: string;
    organization_id: string;
    first_name: string;
    last_name: string;
    email: string;
    created_at: Date;
  }

  // Insert type - omits auto-generated fields (id, created_at, updated_at)
  // and tenant columns (app_id, organization_id)
  export interface ContactsInsert {
    first_name: string;
    last_name: string;
    email: string;
  }

  // Update type - all fields optional for partial updates
  export interface ContactsUpdate {
    first_name?: string | null;
    last_name?: string | null;
    email?: string | null;
  }

  export type TableName = 'contacts';
}
```

With `--zod` flag, Zod validation schemas are also generated:

```typescript
import { z } from 'zod';

export const crmContactsSchema = z.object({
  id: z.string().uuid(),
  first_name: z.string(),
  last_name: z.string(),
  email: z.string(),
  created_at: z.coerce.date(),
});

export const crmContactsInsertSchema = z.object({
  first_name: z.string(),
  last_name: z.string(),
  email: z.string(),
});

export const crmContactsUpdateSchema = z.object({
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
});

export type Contacts = z.infer<typeof crmContactsSchema>;
export type ContactsInsert = z.infer<typeof crmContactsInsertSchema>;
export type ContactsUpdate = z.infer<typeof crmContactsUpdateSchema>;
```

## Multi-Database Support

```typescript
// PostgreSQL (auto-detected from connection string)
const pgDb = await createDb({
  connectionString: 'postgresql://localhost/mydb',
});

// MySQL
const mysqlDb = await createDb({
  connectionString: 'mysql://localhost/mydb',
});

// SQLite
const sqliteDb = await createDb({
  connectionString: 'sqlite://./data.db',
});
```

| Feature | PostgreSQL | MySQL | SQLite |
|---------|------------|-------|--------|
| Transactional DDL | ✅ | ❌ | ✅ |
| RETURNING clause | ✅ | ❌ | ❌ |
| JSON/JSONB | ✅ | ✅ | Text |
| ALTER COLUMN | ✅ | ✅ | ❌* |

*SQLite requires table recreation for column alterations.

## API Reference

### DbClient

```typescript
const db = await createDb(options);

// Query builder
db.table<T>(name, ctx)          // Returns TableBuilder with tenant injection
db.tableWithoutTenant<T>(name)  // Returns TableBuilder without tenant injection

// Transactions
db.transaction(ctx, async (trx) => { ... })

// Raw queries
db.raw<T>(sql, params)
db.rawWithTenant<T>(ctx, sql, params)
db.execute(sql, params)

// Migrations
db.migrations.up(options)
db.migrations.down(options)
db.migrations.status(options)
db.migrations.verify(options)

// Schema registry
db.schema.register(options)
db.schema.get(appId, schemaName)
db.schema.list(appId?)

// Cleanup
db.close()
```

### TableBuilder

```typescript
db.table('users', ctx)
  .select('id', 'email')
  .where('status', '=', 'active')
  .whereIn('role', ['admin', 'user'])
  .whereNull('deleted_at')
  .orderBy('created_at', 'desc')
  .limit(10)
  .offset(0)
  .execute()

db.table('users', ctx)
  .insert()
  .values({ email: 'test@example.com' })
  .returning('id')
  .execute()

db.table('users', ctx)
  .update()
  .set({ status: 'inactive' })
  .where('id', '=', userId)
  .execute()

db.table('users', ctx)
  .delete()
  .where('id', '=', userId)
  .execute()
```

## Why @launchpad/db-engine?

Unlike traditional ORMs, `@launchpad/db-engine` is designed specifically for multi-tenant BaaS platforms:

1. **Tenant isolation by default**: Every query is automatically scoped to the current tenant
2. **No data leakage**: Impossible to accidentally query across tenants
3. **Dynamic schemas**: Register new table schemas at runtime without migrations
4. **Type generation**: Get full TypeScript types from your dynamic schemas

## Documentation

- [Migration Guide](docs/MIGRATION_GUIDE.md) - Migrate from raw SQL to QueryBuilder with before/after examples

## Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) for details.

## License

MIT © [AudioGenius](https://audiogenius.ai)
