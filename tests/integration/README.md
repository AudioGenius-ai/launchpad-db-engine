# Integration Tests

This directory contains integration tests that run against a real PostgreSQL database.

## Running Integration Tests

### Prerequisites

You need a running PostgreSQL database. The tests will be skipped if `DATABASE_URL` is not set.

### Option 1: Using Docker

```bash
docker run -d \
  --name db-engine-test-postgres \
  -e POSTGRES_USER=test \
  -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=test \
  -p 5432:5432 \
  postgres:16
```

Then run the tests:

```bash
DATABASE_URL=postgres://test:test@localhost:5432/test pnpm test
```

To stop and remove the container:

```bash
docker stop db-engine-test-postgres
docker rm db-engine-test-postgres
```

### Option 2: Local PostgreSQL Installation

If you have PostgreSQL installed locally, create a test database and run:

```bash
DATABASE_URL=postgres://username:password@localhost:5432/testdb pnpm test
```

### Running Only Integration Tests

```bash
DATABASE_URL=postgres://test:test@localhost:5432/test pnpm test tests/integration
```

### CI/CD

The GitHub Actions CI workflow automatically runs these tests against PostgreSQL 16:
- Database: postgres://test:test@localhost:5432/test
- Tests run on Node.js versions 18, 20, and 22

## Test Coverage

### PostgreSQL Driver Tests (`postgresql.test.ts`)

- **Database Connection**: Verifies connection to PostgreSQL
- **Basic Query Execution**: SELECT, INSERT, UPDATE, DELETE operations
- **Parameterized Queries**: Tests with prepared statements and parameters
- **Transactions**:
  - Commit successful transactions
  - Rollback on errors
  - Handle constraint violations
- **DbClient Integration**:
  - Table builder with tenant context
  - Transaction with tenant context variables (SET LOCAL)
  - Raw query methods

## Test Structure

Each test file:
1. Uses `describe.skipIf(!process.env.DATABASE_URL)` to skip when no database is available
2. Creates test tables in `beforeAll()`
3. Cleans up test tables in `afterAll()`
4. Uses unique table names to avoid conflicts
5. Tests isolation - each test should be independent

## Adding New Integration Tests

When adding new integration tests:

1. Use `describe.skipIf(!process.env.DATABASE_URL)` at the top level
2. Create test tables with unique names (e.g., `test_integration_*`)
3. Clean up resources in `afterAll()`
4. Handle database connection cleanup properly
5. Make tests deterministic and independent
