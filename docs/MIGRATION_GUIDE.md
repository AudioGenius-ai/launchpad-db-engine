# Migrating from Raw SQL to QueryBuilder

This guide shows how to migrate from raw SQL queries to the `@launchpad/db-engine` QueryBuilder API. The QueryBuilder provides:

- **Type safety**: Full TypeScript support with autocompletion
- **SQL injection prevention**: All values are parameterized automatically
- **Multi-tenancy**: Automatic `app_id` and `organization_id` injection
- **Consistency**: Uniform API across PostgreSQL, MySQL, and SQLite

## Table of Contents

- [SelectBuilder](#selectbuilder)
- [InsertBuilder](#insertbuilder)
- [UpdateBuilder](#updatebuilder)
- [DeleteBuilder](#deletebuilder)
- [Common Patterns](#common-patterns)
- [When to Use Raw SQL](#when-to-use-raw-sql)

---

## SelectBuilder

### Basic SELECT

**Before (Raw SQL):**
```typescript
const sql = 'SELECT * FROM users WHERE status = $1';
const result = await pool.query(sql, ['active']);
return result.rows;
```

**After (QueryBuilder):**
```typescript
const users = await db.table<User>('users', ctx)
  .select()
  .where('status', '=', 'active')
  .execute();
```

### SELECT with Multiple Conditions

**Before:**
```typescript
const sql = `
  SELECT id, email, name
  FROM users
  WHERE status = $1 AND role = $2 AND created_at >= $3
`;
const result = await pool.query(sql, ['active', 'admin', startDate]);
```

**After:**
```typescript
const users = await db.table<User>('users', ctx)
  .select('id', 'email', 'name')
  .where('status', '=', 'active')
  .where('role', '=', 'admin')
  .where('created_at', '>=', startDate)
  .execute();
```

### SELECT with Pagination

**Before:**
```typescript
let paramIndex = 1;
const params = [];
let sql = 'SELECT * FROM users';

if (filter.status) {
  sql += ` WHERE status = $${paramIndex++}`;
  params.push(filter.status);
}

sql += ` ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
params.push(limit, offset);

const result = await pool.query(sql, params);
```

**After:**
```typescript
let query = db.table<User>('users', ctx).select();

if (filter.status) {
  query = query.where('status', '=', filter.status);
}

const users = await query
  .orderBy('created_at', 'desc')
  .limit(limit)
  .offset(offset)
  .execute();
```

### SELECT with IN Clause

**Before:**
```typescript
const ids = ['id1', 'id2', 'id3'];
const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
const sql = `SELECT * FROM users WHERE id IN (${placeholders})`;
const result = await pool.query(sql, ids);
```

**After:**
```typescript
const users = await db.table<User>('users', ctx)
  .select()
  .whereIn('id', ['id1', 'id2', 'id3'])
  .execute();
```

### SELECT with NULL Checks

**Before:**
```typescript
const sql = 'SELECT * FROM users WHERE deleted_at IS NULL AND verified_at IS NOT NULL';
const result = await pool.query(sql);
```

**After:**
```typescript
const users = await db.table<User>('users', ctx)
  .select()
  .whereNull('deleted_at')
  .whereNotNull('verified_at')
  .execute();
```

### SELECT with LIKE/ILIKE

**Before:**
```typescript
const sql = 'SELECT * FROM users WHERE name ILIKE $1';
const result = await pool.query(sql, [`%${searchTerm}%`]);
```

**After:**
```typescript
const users = await db.table<User>('users', ctx)
  .select()
  .whereILike('name', `%${searchTerm}%`)
  .execute();
```

### SELECT with JOIN

**Before:**
```typescript
const sql = `
  SELECT u.*, o.name as org_name
  FROM users u
  INNER JOIN organizations o ON o.id = u.organization_id
  WHERE u.status = $1
`;
const result = await pool.query(sql, ['active']);
```

**After:**
```typescript
const users = await db.table<User>('users', ctx)
  .select()
  .innerJoin('organizations', 'users.organization_id', 'organizations.id', 'o')
  .where('status', '=', 'active')
  .execute();
```

### SELECT First Record

**Before:**
```typescript
const sql = 'SELECT * FROM users WHERE email = $1 LIMIT 1';
const result = await pool.query(sql, [email]);
return result.rows[0] ?? null;
```

**After:**
```typescript
const user = await db.table<User>('users', ctx)
  .select()
  .where('email', '=', email)
  .first();
```

### SELECT Count

**Before:**
```typescript
const sql = 'SELECT COUNT(*) as count FROM users WHERE status = $1';
const result = await pool.query(sql, ['active']);
return parseInt(result.rows[0].count, 10);
```

**After:**
```typescript
const count = await db.table<User>('users', ctx)
  .select()
  .where('status', '=', 'active')
  .count();
```

### SELECT with GROUP BY and HAVING

**Before:**
```typescript
const sql = `
  SELECT department, COUNT(*) as count
  FROM employees
  GROUP BY department
  HAVING COUNT(*) > $1
`;
const result = await pool.query(sql, [5]);
```

**After:**
```typescript
const results = await db.table<Employee>('employees', ctx)
  .select('department')
  .groupBy('department')
  .having('count', '>', 5)
  .execute();
```

---

## InsertBuilder

### Basic INSERT

**Before:**
```typescript
const sql = `
  INSERT INTO users (email, name, status, app_id, organization_id)
  VALUES ($1, $2, $3, $4, $5)
  RETURNING *
`;
const result = await pool.query(sql, [email, name, 'pending', appId, orgId]);
return result.rows[0];
```

**After:**
```typescript
// Tenant columns (app_id, organization_id) are injected automatically
const [user] = await db.table<User>('users', ctx)
  .insert()
  .values({ email, name, status: 'pending' })
  .returning('*')
  .execute();
```

### INSERT with Selected Returning Columns

**Before:**
```typescript
const sql = 'INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id, email';
const result = await pool.query(sql, [email, name]);
```

**After:**
```typescript
const [user] = await db.table<User>('users', ctx)
  .insert()
  .values({ email, name })
  .returning('id', 'email')
  .execute();
```

### INSERT Multiple Rows

**Before:**
```typescript
const values = users.map((u, i) => `($${i*2+1}, $${i*2+2})`).join(', ');
const params = users.flatMap(u => [u.email, u.name]);
const sql = `INSERT INTO users (email, name) VALUES ${values}`;
await pool.query(sql, params);
```

**After:**
```typescript
await db.table<User>('users', ctx)
  .insert()
  .valuesMany([
    { email: 'user1@example.com', name: 'User 1' },
    { email: 'user2@example.com', name: 'User 2' },
  ])
  .execute();
```

### INSERT with ON CONFLICT (Upsert)

**Before:**
```typescript
const sql = `
  INSERT INTO users (email, name)
  VALUES ($1, $2)
  ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
  RETURNING *
`;
const result = await pool.query(sql, [email, name]);
```

**After:**
```typescript
const [user] = await db.table<User>('users', ctx)
  .insert()
  .values({ email, name })
  .onConflict(['email'], 'update', ['name'])
  .returning('*')
  .execute();
```

---

## UpdateBuilder

### Basic UPDATE

**Before:**
```typescript
const sql = 'UPDATE users SET name = $1, updated_at = $2 WHERE id = $3 RETURNING *';
const result = await pool.query(sql, [name, new Date(), id]);
return result.rows[0];
```

**After:**
```typescript
const [user] = await db.table<User>('users', ctx)
  .update()
  .set({ name, updated_at: new Date() })
  .where('id', '=', id)
  .returning('*')
  .execute();
```

### UPDATE with Multiple Conditions

**Before:**
```typescript
const sql = `
  UPDATE users
  SET status = $1, updated_at = $2
  WHERE role = $3 AND created_at < $4
`;
await pool.query(sql, ['inactive', new Date(), 'guest', cutoffDate]);
```

**After:**
```typescript
await db.table<User>('users', ctx)
  .update()
  .set({ status: 'inactive', updated_at: new Date() })
  .where('role', '=', 'guest')
  .where('created_at', '<', cutoffDate)
  .execute();
```

### UPDATE Chained from Table Builder

**Before:**
```typescript
const sql = 'UPDATE users SET verified = $1 WHERE email = $2';
await pool.query(sql, [true, email]);
```

**After:**
```typescript
await db.table<User>('users', ctx)
  .where('email', '=', email)
  .update({ verified: true })
  .execute();
```

---

## DeleteBuilder

### Basic DELETE

**Before:**
```typescript
const sql = 'DELETE FROM users WHERE id = $1 RETURNING id';
const result = await pool.query(sql, [id]);
return result.rowCount > 0;
```

**After:**
```typescript
const deleted = await db.table<User>('users', ctx)
  .delete()
  .where('id', '=', id)
  .returning('id')
  .execute();
return deleted.length > 0;
```

### DELETE with Multiple Conditions

**Before:**
```typescript
const sql = 'DELETE FROM sessions WHERE user_id = $1 AND expires_at < $2';
await pool.query(sql, [userId, new Date()]);
```

**After:**
```typescript
await db.table<Session>('sessions', ctx)
  .delete()
  .where('user_id', '=', userId)
  .where('expires_at', '<', new Date())
  .execute();
```

### DELETE Chained from Table Builder

**Before:**
```typescript
const sql = 'DELETE FROM users WHERE status = $1';
await pool.query(sql, ['deleted']);
```

**After:**
```typescript
await db.table<User>('users', ctx)
  .where('status', '=', 'deleted')
  .delete()
  .execute();
```

---

## Common Patterns

### Using findById Helper

```typescript
// Simplified lookup by ID
const user = await db.table<User>('users', ctx).findById(userId);
if (!user) {
  throw new Error('User not found');
}
```

### Using findMany Helper

```typescript
const users = await db.table<User>('users', ctx).findMany({
  where: [
    { column: 'status', op: '=', value: 'active' },
    { column: 'role', op: 'IN', value: ['admin', 'moderator'] },
  ],
  orderBy: { column: 'created_at', direction: 'desc' },
  limit: 50,
  offset: 0,
});
```

### Debugging Queries with toSQL()

```typescript
const query = db.table<User>('users', ctx)
  .select('id', 'email')
  .where('status', '=', 'active');

// Inspect the generated SQL without executing
const { sql, params } = query.toSQL();
console.log('SQL:', sql);
console.log('Params:', params);

// Then execute
const users = await query.execute();
```

### Tables Without Tenant Context

For tables that don't require multi-tenancy (e.g., system tables):

```typescript
// No tenant injection - use with caution
const settings = await db.tableWithoutTenant<SystemSetting>('system_settings')
  .select()
  .where('key', '=', 'app_version')
  .first();
```

### Transactions

```typescript
const result = await db.transaction(ctx, async (trx) => {
  // Create organization
  const [org] = await trx.table<Organization>('organizations')
    .insert()
    .values({ name: 'Acme Inc' })
    .returning('id')
    .execute();

  // Create admin user
  const [user] = await trx.table<User>('users')
    .insert()
    .values({
      email: 'admin@acme.com',
      organization_id: org.id,
      role: 'admin',
    })
    .returning('*')
    .execute();

  return { org, user };
});
```

---

## When to Use Raw SQL

While QueryBuilder handles most cases, use `db.raw()` for:

### PostgreSQL-Specific Features

```typescript
// Array operators (&&, @>, <@)
const result = await db.raw<{ id: string }>(
  `SELECT id FROM posts WHERE tags && $1`,
  [['typescript', 'nodejs']]
);

// Full-text search
const results = await db.raw<Post>(
  `SELECT * FROM posts WHERE to_tsvector('english', title || ' ' || content) @@ plainto_tsquery($1)`,
  [searchQuery]
);

// JSON operators
const users = await db.raw<User>(
  `SELECT * FROM users WHERE metadata->>'department' = $1`,
  ['engineering']
);
```

### Complex Aggregations

```typescript
const stats = await db.raw<{ month: string; count: number }>(
  `SELECT
    date_trunc('month', created_at) as month,
    COUNT(*) as count
   FROM orders
   WHERE app_id = $1 AND organization_id = $2
   GROUP BY date_trunc('month', created_at)
   ORDER BY month DESC`,
  [ctx.appId, ctx.organizationId]
);
```

### Window Functions

```typescript
const rankings = await db.raw<{ user_id: string; rank: number }>(
  `SELECT
    user_id,
    RANK() OVER (ORDER BY total_sales DESC) as rank
   FROM sales_summary
   WHERE app_id = $1`,
  [ctx.appId]
);
```

### CTEs (Common Table Expressions)

```typescript
const results = await db.raw<HierarchyNode>(
  `WITH RECURSIVE category_tree AS (
    SELECT id, name, parent_id, 1 as depth
    FROM categories
    WHERE parent_id IS NULL AND app_id = $1

    UNION ALL

    SELECT c.id, c.name, c.parent_id, ct.depth + 1
    FROM categories c
    INNER JOIN category_tree ct ON ct.id = c.parent_id
  )
  SELECT * FROM category_tree ORDER BY depth, name`,
  [ctx.appId]
);
```

---

## Migration Checklist

When migrating from raw SQL to QueryBuilder:

1. **Identify tenant columns** - Remove manual `app_id` and `organization_id` from INSERT statements
2. **Replace parameter tracking** - No more `$${paramIndex++}` patterns
3. **Use typed table definitions** - Create interfaces for your tables
4. **Add tenant context** - Pass `ctx` to `db.table()` calls
5. **Test thoroughly** - Use `toSQL()` to verify generated queries match expectations
6. **Keep complex queries as raw** - PostgreSQL-specific features may require `db.raw()`

---

## API Reference Summary

### SelectBuilder Methods

| Method | Description |
|--------|-------------|
| `select(...columns)` | Specify columns to select |
| `where(column, op, value)` | Add WHERE condition |
| `whereNull(column)` | Add IS NULL condition |
| `whereNotNull(column)` | Add IS NOT NULL condition |
| `whereIn(column, values)` | Add IN condition |
| `whereNotIn(column, values)` | Add NOT IN condition |
| `whereLike(column, pattern)` | Add LIKE condition |
| `whereILike(column, pattern)` | Add ILIKE condition (case-insensitive) |
| `orWhere(column, op, value)` | Add OR condition |
| `orderBy(column, direction)` | Add ORDER BY |
| `limit(n)` | Add LIMIT |
| `offset(n)` | Add OFFSET |
| `groupBy(...columns)` | Add GROUP BY |
| `having(column, op, value)` | Add HAVING |
| `innerJoin(table, left, right, alias?)` | Add INNER JOIN |
| `leftJoin(table, left, right, alias?)` | Add LEFT JOIN |
| `execute()` | Execute and return rows |
| `first()` | Execute and return first row or null |
| `count()` | Execute and return count |
| `toSQL()` | Get generated SQL without executing |

### InsertBuilder Methods

| Method | Description |
|--------|-------------|
| `values(data)` | Set data to insert |
| `valuesMany(rows)` | Insert multiple rows |
| `onConflict(columns, action, updateColumns?)` | Handle conflicts |
| `returning(...columns)` | Specify RETURNING columns |
| `execute()` | Execute insert |
| `toSQL()` | Get generated SQL |

### UpdateBuilder Methods

| Method | Description |
|--------|-------------|
| `set(data)` | Set columns to update |
| `where(column, op, value)` | Add WHERE condition |
| `returning(...columns)` | Specify RETURNING columns |
| `execute()` | Execute update |
| `toSQL()` | Get generated SQL |

### DeleteBuilder Methods

| Method | Description |
|--------|-------------|
| `where(column, op, value)` | Add WHERE condition |
| `returning(...columns)` | Specify RETURNING columns |
| `execute()` | Execute delete |
| `toSQL()` | Get generated SQL |

### TableBuilder Helper Methods

| Method | Description |
|--------|-------------|
| `findById(id)` | Find record by ID |
| `findMany(options)` | Find records with options |
