import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDbClient } from '../../src/client.js';
import type { DbClient } from '../../src/client.js';
import { createPostgresDriver } from '../../src/driver/postgresql.js';
import type { Driver } from '../../src/driver/types.js';

/**
 * Integration tests verifying db-engine works correctly with module store patterns.
 * These tests simulate how module stores (Storage, Workflows, Secrets, etc.) interact
 * with db-engine for multi-tenant data access.
 */
describe.skipIf(!process.env.DATABASE_URL)('Module Store Integration Tests', () => {
  let driver: Driver;
  let db: DbClient;

  // Tenant contexts for isolation testing
  const tenant1 = { appId: 'module-app-1', organizationId: 'module-org-1' };
  const tenant2 = { appId: 'module-app-2', organizationId: 'module-org-2' };

  beforeAll(async () => {
    driver = createPostgresDriver({
      connectionString: process.env.DATABASE_URL as string,
    });

    db = createDbClient(driver, {
      tenantColumns: {
        appId: 'app_id',
        organizationId: 'organization_id',
      },
    });
  });

  afterAll(async () => {
    await db.close();
  });

  describe('Storage Metadata Store Pattern', () => {
    const storageTable = 'test_storage_metadata';

    beforeAll(async () => {
      await driver.execute(`
        DROP TABLE IF EXISTS ${storageTable};
        CREATE TABLE ${storageTable} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          bucket VARCHAR(255) NOT NULL,
          path VARCHAR(1024) NOT NULL,
          filename VARCHAR(255) NOT NULL,
          content_type VARCHAR(255),
          size_bytes BIGINT NOT NULL DEFAULT 0,
          checksum VARCHAR(64),
          app_id VARCHAR(255) NOT NULL,
          organization_id VARCHAR(255) NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(app_id, organization_id, bucket, path)
        );
        CREATE INDEX idx_${storageTable}_tenant ON ${storageTable}(app_id, organization_id);
        CREATE INDEX idx_${storageTable}_bucket ON ${storageTable}(app_id, organization_id, bucket);
      `);
    });

    afterAll(async () => {
      await driver.execute(`DROP TABLE IF EXISTS ${storageTable}`);
    });

    beforeEach(async () => {
      await driver.execute(`DELETE FROM ${storageTable}`);
    });

    it('should store file metadata with tenant isolation', async () => {
      // Tenant 1 uploads a file
      await db
        .table(storageTable, tenant1)
        .insert()
        .values({
          bucket: 'uploads',
          path: '/documents/report.pdf',
          filename: 'report.pdf',
          content_type: 'application/pdf',
          size_bytes: 1024000,
          checksum: 'abc123',
        })
        .execute();

      // Tenant 2 uploads a file with same path
      await db
        .table(storageTable, tenant2)
        .insert()
        .values({
          bucket: 'uploads',
          path: '/documents/report.pdf',
          filename: 'report.pdf',
          content_type: 'application/pdf',
          size_bytes: 2048000,
          checksum: 'def456',
        })
        .execute();

      // Tenant 1 can only see their file
      const tenant1Files = await db
        .table(storageTable, tenant1)
        .select('*')
        .where('bucket', '=', 'uploads')
        .execute();

      expect(tenant1Files).toHaveLength(1);
      expect(tenant1Files[0].size_bytes).toBe(1024000);

      // Tenant 2 can only see their file
      const tenant2Files = await db
        .table(storageTable, tenant2)
        .select('*')
        .where('bucket', '=', 'uploads')
        .execute();

      expect(tenant2Files).toHaveLength(1);
      expect(tenant2Files[0].size_bytes).toBe(2048000);
    });

    it('should list files in a bucket', async () => {
      // Upload multiple files
      await db
        .table(storageTable, tenant1)
        .insert()
        .values([
          {
            bucket: 'images',
            path: '/photo1.jpg',
            filename: 'photo1.jpg',
            content_type: 'image/jpeg',
            size_bytes: 100,
          },
          {
            bucket: 'images',
            path: '/photo2.jpg',
            filename: 'photo2.jpg',
            content_type: 'image/jpeg',
            size_bytes: 200,
          },
          {
            bucket: 'documents',
            path: '/doc.pdf',
            filename: 'doc.pdf',
            content_type: 'application/pdf',
            size_bytes: 300,
          },
        ])
        .execute();

      const imageFiles = await db
        .table(storageTable, tenant1)
        .select('filename', 'size_bytes')
        .where('bucket', '=', 'images')
        .orderBy('filename', 'asc')
        .execute();

      expect(imageFiles).toHaveLength(2);
      expect(imageFiles[0].filename).toBe('photo1.jpg');
      expect(imageFiles[1].filename).toBe('photo2.jpg');
    });

    it('should delete file metadata', async () => {
      await db
        .table(storageTable, tenant1)
        .insert()
        .values({ bucket: 'temp', path: '/temp.txt', filename: 'temp.txt', size_bytes: 10 })
        .execute();

      await db.table(storageTable, tenant1).delete().where('path', '=', '/temp.txt').execute();

      const files = await db
        .table(storageTable, tenant1)
        .select('*')
        .where('bucket', '=', 'temp')
        .execute();

      expect(files).toHaveLength(0);
    });
  });

  describe('Workflow Execution Store Pattern', () => {
    const workflowTable = 'test_workflow_executions';

    beforeAll(async () => {
      await driver.execute(`
        DROP TABLE IF EXISTS ${workflowTable};
        CREATE TABLE ${workflowTable} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          workflow_id UUID NOT NULL,
          status VARCHAR(50) NOT NULL DEFAULT 'pending',
          input JSONB,
          output JSONB,
          error TEXT,
          started_at TIMESTAMPTZ,
          completed_at TIMESTAMPTZ,
          app_id VARCHAR(255) NOT NULL,
          organization_id VARCHAR(255) NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX idx_${workflowTable}_tenant ON ${workflowTable}(app_id, organization_id);
        CREATE INDEX idx_${workflowTable}_workflow ON ${workflowTable}(app_id, organization_id, workflow_id);
        CREATE INDEX idx_${workflowTable}_status ON ${workflowTable}(app_id, organization_id, status);
      `);
    });

    afterAll(async () => {
      await driver.execute(`DROP TABLE IF EXISTS ${workflowTable}`);
    });

    beforeEach(async () => {
      await driver.execute(`DELETE FROM ${workflowTable}`);
    });

    it('should create and track workflow execution', async () => {
      const workflowId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

      // Create execution
      const [execution] = await db
        .table(workflowTable, tenant1)
        .insert()
        .values({
          workflow_id: workflowId,
          status: 'running',
          input: { orderId: '12345' },
          started_at: new Date(),
        })
        .returning('id', 'status')
        .execute();

      expect(execution.status).toBe('running');

      // Update execution status
      await db
        .table(workflowTable, tenant1)
        .update()
        .set({
          status: 'completed',
          output: { result: 'success' },
          completed_at: new Date(),
        })
        .where('id', '=', execution.id)
        .execute();

      // Verify update
      const [updated] = await db
        .table(workflowTable, tenant1)
        .select('*')
        .where('id', '=', execution.id)
        .execute();

      expect(updated.status).toBe('completed');
      expect(updated.output).toEqual({ result: 'success' });
    });

    it('should query executions by status', async () => {
      const workflowId = 'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';

      await db
        .table(workflowTable, tenant1)
        .insert()
        .values([
          { workflow_id: workflowId, status: 'completed', input: {} },
          { workflow_id: workflowId, status: 'completed', input: {} },
          { workflow_id: workflowId, status: 'failed', input: {}, error: 'Timeout' },
          { workflow_id: workflowId, status: 'running', input: {} },
        ])
        .execute();

      const completed = await db
        .table(workflowTable, tenant1)
        .select('*')
        .where('status', '=', 'completed')
        .execute();

      expect(completed).toHaveLength(2);

      const failed = await db
        .table(workflowTable, tenant1)
        .select('*')
        .where('status', '=', 'failed')
        .execute();

      expect(failed).toHaveLength(1);
      expect(failed[0].error).toBe('Timeout');
    });
  });

  describe('Secrets Store Pattern', () => {
    const secretsTable = 'test_secrets';

    beforeAll(async () => {
      await driver.execute(`
        DROP TABLE IF EXISTS ${secretsTable};
        CREATE TABLE ${secretsTable} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name VARCHAR(255) NOT NULL,
          encrypted_value TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          is_active BOOLEAN NOT NULL DEFAULT true,
          app_id VARCHAR(255) NOT NULL,
          organization_id VARCHAR(255) NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          rotated_at TIMESTAMPTZ,
          UNIQUE(app_id, organization_id, name, version)
        );
        CREATE INDEX idx_${secretsTable}_tenant ON ${secretsTable}(app_id, organization_id);
        CREATE INDEX idx_${secretsTable}_name ON ${secretsTable}(app_id, organization_id, name);
      `);
    });

    afterAll(async () => {
      await driver.execute(`DROP TABLE IF EXISTS ${secretsTable}`);
    });

    beforeEach(async () => {
      await driver.execute(`DELETE FROM ${secretsTable}`);
    });

    it('should store and retrieve encrypted secrets', async () => {
      await db
        .table(secretsTable, tenant1)
        .insert()
        .values({
          name: 'API_KEY',
          encrypted_value: 'encrypted:abc123xyz',
          version: 1,
          is_active: true,
        })
        .execute();

      const [secret] = await db
        .table(secretsTable, tenant1)
        .select('name', 'encrypted_value', 'version')
        .where('name', '=', 'API_KEY')
        .where('is_active', '=', true)
        .execute();

      expect(secret.name).toBe('API_KEY');
      expect(secret.encrypted_value).toBe('encrypted:abc123xyz');
    });

    it('should handle secret rotation with versions', async () => {
      // Create initial secret
      await db
        .table(secretsTable, tenant1)
        .insert()
        .values({
          name: 'DB_PASSWORD',
          encrypted_value: 'encrypted:oldpassword',
          version: 1,
          is_active: true,
        })
        .execute();

      // Rotate secret - mark old as inactive
      await db
        .table(secretsTable, tenant1)
        .update()
        .set({ is_active: false, rotated_at: new Date() })
        .where('name', '=', 'DB_PASSWORD')
        .where('version', '=', 1)
        .execute();

      // Create new version
      await db
        .table(secretsTable, tenant1)
        .insert()
        .values({
          name: 'DB_PASSWORD',
          encrypted_value: 'encrypted:newpassword',
          version: 2,
          is_active: true,
        })
        .execute();

      // Get active secret
      const [activeSecret] = await db
        .table(secretsTable, tenant1)
        .select('*')
        .where('name', '=', 'DB_PASSWORD')
        .where('is_active', '=', true)
        .execute();

      expect(activeSecret.version).toBe(2);
      expect(activeSecret.encrypted_value).toBe('encrypted:newpassword');

      // Verify old version still exists but inactive
      const allVersions = await db
        .table(secretsTable, tenant1)
        .select('version', 'is_active')
        .where('name', '=', 'DB_PASSWORD')
        .orderBy('version', 'asc')
        .execute();

      expect(allVersions).toHaveLength(2);
      expect(allVersions[0].is_active).toBe(false);
      expect(allVersions[1].is_active).toBe(true);
    });

    it('should enforce tenant isolation for secrets', async () => {
      await db
        .table(secretsTable, tenant1)
        .insert()
        .values({ name: 'SHARED_NAME', encrypted_value: 'tenant1secret', version: 1 })
        .execute();

      await db
        .table(secretsTable, tenant2)
        .insert()
        .values({ name: 'SHARED_NAME', encrypted_value: 'tenant2secret', version: 1 })
        .execute();

      const tenant1Secret = await db
        .table(secretsTable, tenant1)
        .select('encrypted_value')
        .where('name', '=', 'SHARED_NAME')
        .execute();

      const tenant2Secret = await db
        .table(secretsTable, tenant2)
        .select('encrypted_value')
        .where('name', '=', 'SHARED_NAME')
        .execute();

      expect(tenant1Secret[0].encrypted_value).toBe('tenant1secret');
      expect(tenant2Secret[0].encrypted_value).toBe('tenant2secret');
    });
  });

  describe('Cross-Module Transactions', () => {
    const ordersTable = 'test_orders';
    const paymentsTable = 'test_payments';

    beforeAll(async () => {
      await driver.execute(`
        DROP TABLE IF EXISTS ${paymentsTable};
        DROP TABLE IF EXISTS ${ordersTable};
        
        CREATE TABLE ${ordersTable} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          customer_id UUID NOT NULL,
          total_amount DECIMAL(10, 2) NOT NULL,
          status VARCHAR(50) NOT NULL DEFAULT 'pending',
          app_id VARCHAR(255) NOT NULL,
          organization_id VARCHAR(255) NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        
        CREATE TABLE ${paymentsTable} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          order_id UUID NOT NULL REFERENCES ${ordersTable}(id),
          amount DECIMAL(10, 2) NOT NULL,
          status VARCHAR(50) NOT NULL DEFAULT 'pending',
          provider_ref VARCHAR(255),
          app_id VARCHAR(255) NOT NULL,
          organization_id VARCHAR(255) NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        
        CREATE INDEX idx_${ordersTable}_tenant ON ${ordersTable}(app_id, organization_id);
        CREATE INDEX idx_${paymentsTable}_tenant ON ${paymentsTable}(app_id, organization_id);
      `);
    });

    afterAll(async () => {
      await driver.execute(`DROP TABLE IF EXISTS ${paymentsTable}`);
      await driver.execute(`DROP TABLE IF EXISTS ${ordersTable}`);
    });

    beforeEach(async () => {
      await driver.execute(`DELETE FROM ${paymentsTable}`);
      await driver.execute(`DELETE FROM ${ordersTable}`);
    });

    it('should handle cross-module transaction commit', async () => {
      const customerId = 'c1eebc99-9c0b-4ef8-bb6d-6bb9bd380a33';

      const orderId = await db.transaction(tenant1, async (trx) => {
        // Create order
        const [order] = await trx
          .raw<{ id: string }>(
            `INSERT INTO ${ordersTable} (customer_id, total_amount, status, app_id, organization_id)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [customerId, 99.99, 'confirmed', tenant1.appId, tenant1.organizationId]
          )
          .then((r) => r.rows);

        // Create payment record
        await trx.raw(
          `INSERT INTO ${paymentsTable} (order_id, amount, status, provider_ref, app_id, organization_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [order.id, 99.99, 'completed', 'stripe_pi_123', tenant1.appId, tenant1.organizationId]
        );

        return order.id;
      });

      // Verify both records exist
      const orders = await db
        .table(ordersTable, tenant1)
        .select('*')
        .where('id', '=', orderId)
        .execute();
      const payments = await db
        .table(paymentsTable, tenant1)
        .select('*')
        .where('order_id', '=', orderId)
        .execute();

      expect(orders).toHaveLength(1);
      expect(payments).toHaveLength(1);
      expect(orders[0].status).toBe('confirmed');
      expect(payments[0].status).toBe('completed');
    });

    it('should rollback cross-module transaction on error', async () => {
      const customerId = 'd1eebc99-9c0b-4ef8-bb6d-6bb9bd380a44';

      await expect(async () => {
        await db.transaction(tenant1, async (trx) => {
          // Create order
          const [order] = await trx
            .raw<{ id: string }>(
              `INSERT INTO ${ordersTable} (customer_id, total_amount, status, app_id, organization_id)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
              [customerId, 149.99, 'pending', tenant1.appId, tenant1.organizationId]
            )
            .then((r) => r.rows);

          // Simulate payment failure
          throw new Error('Payment declined');
        });
      }).rejects.toThrow('Payment declined');

      // Verify neither record exists
      const orders = await db
        .table(ordersTable, tenant1)
        .select('*')
        .where('customer_id', '=', customerId)
        .execute();

      expect(orders).toHaveLength(0);
    });
  });

  describe('Concurrent Operations', () => {
    const counterTable = 'test_counters';

    beforeAll(async () => {
      await driver.execute(`
        DROP TABLE IF EXISTS ${counterTable};
        CREATE TABLE ${counterTable} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name VARCHAR(255) NOT NULL,
          value INTEGER NOT NULL DEFAULT 0,
          app_id VARCHAR(255) NOT NULL,
          organization_id VARCHAR(255) NOT NULL,
          UNIQUE(app_id, organization_id, name)
        );
        CREATE INDEX idx_${counterTable}_tenant ON ${counterTable}(app_id, organization_id);
      `);
    });

    afterAll(async () => {
      await driver.execute(`DROP TABLE IF EXISTS ${counterTable}`);
    });

    beforeEach(async () => {
      await driver.execute(`DELETE FROM ${counterTable}`);
    });

    it('should handle concurrent increments with transactions', async () => {
      // Create initial counter
      await db
        .table(counterTable, tenant1)
        .insert()
        .values({ name: 'page_views', value: 0 })
        .execute();

      // Simulate concurrent increments
      const incrementCount = 10;
      const incrementPromises = Array.from({ length: incrementCount }, () =>
        db.transaction(tenant1, async (trx) => {
          await trx.raw(
            `UPDATE ${counterTable} SET value = value + 1 
             WHERE name = $1 AND app_id = $2 AND organization_id = $3`,
            ['page_views', tenant1.appId, tenant1.organizationId]
          );
        })
      );

      await Promise.all(incrementPromises);

      // Verify final count
      const [counter] = await db
        .table(counterTable, tenant1)
        .select('value')
        .where('name', '=', 'page_views')
        .execute();

      expect(counter.value).toBe(incrementCount);
    });

    it('should isolate concurrent operations between tenants', async () => {
      // Create counters for both tenants
      await db
        .table(counterTable, tenant1)
        .insert()
        .values({ name: 'shared_counter', value: 0 })
        .execute();

      await db
        .table(counterTable, tenant2)
        .insert()
        .values({ name: 'shared_counter', value: 0 })
        .execute();

      // Concurrent operations on both tenants
      const ops = [
        ...Array.from({ length: 5 }, () =>
          db.transaction(tenant1, async (trx) => {
            await trx.raw(
              `UPDATE ${counterTable} SET value = value + 1 
               WHERE name = $1 AND app_id = $2 AND organization_id = $3`,
              ['shared_counter', tenant1.appId, tenant1.organizationId]
            );
          })
        ),
        ...Array.from({ length: 3 }, () =>
          db.transaction(tenant2, async (trx) => {
            await trx.raw(
              `UPDATE ${counterTable} SET value = value + 1 
               WHERE name = $1 AND app_id = $2 AND organization_id = $3`,
              ['shared_counter', tenant2.appId, tenant2.organizationId]
            );
          })
        ),
      ];

      await Promise.all(ops);

      // Verify tenant isolation
      const [tenant1Counter] = await db
        .table(counterTable, tenant1)
        .select('value')
        .where('name', '=', 'shared_counter')
        .execute();

      const [tenant2Counter] = await db
        .table(counterTable, tenant2)
        .select('value')
        .where('name', '=', 'shared_counter')
        .execute();

      expect(tenant1Counter.value).toBe(5);
      expect(tenant2Counter.value).toBe(3);
    });
  });
});
