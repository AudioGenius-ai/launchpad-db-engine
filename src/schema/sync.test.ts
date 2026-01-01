import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Driver } from '../driver/types.js';
import type { Dialect } from '../migrations/dialects/types.js';
import type { SchemaRemoteClient } from '../remote/client.js';
import { SchemaSyncService } from './sync.js';
import { BreakingChangeError, UserCancelledError } from './types.js';

const createMockDriver = (): Driver => ({
  dialect: 'postgresql',
  connectionString: 'postgresql://test',
  query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  execute: vi.fn().mockResolvedValue({ rowCount: 0 }),
  transaction: vi.fn().mockImplementation(async (fn) =>
    fn({
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      execute: vi.fn().mockResolvedValue({ rowCount: 0 }),
    })
  ),
  close: vi.fn(),
});

const createMockDialect = (): Dialect => ({
  name: 'postgresql',
  supportsTransactionalDDL: true,
  mapType: vi.fn((type) => type.toUpperCase()),
  createTable: vi.fn((name) => `CREATE TABLE "${name}" (...)`),
  dropTable: vi.fn((name) => `DROP TABLE IF EXISTS "${name}" CASCADE`),
  addColumn: vi.fn((table, col) => `ALTER TABLE "${table}" ADD COLUMN "${col}" ...`),
  dropColumn: vi.fn((table, col) => `ALTER TABLE "${table}" DROP COLUMN "${col}"`),
  alterColumn: vi.fn((table, col) => `ALTER TABLE "${table}" ALTER COLUMN "${col}" ...`),
  createIndex: vi.fn((table, idx) => `CREATE INDEX ON "${table}" (...)`),
  dropIndex: vi.fn((name) => `DROP INDEX IF EXISTS "${name}"`),
  addForeignKey: vi.fn(() => 'ALTER TABLE ... ADD CONSTRAINT ...'),
  dropForeignKey: vi.fn(() => 'ALTER TABLE ... DROP CONSTRAINT ...'),
  introspectTablesQuery: vi.fn(),
  introspectColumnsQuery: vi.fn(),
  introspectIndexesQuery: vi.fn(),
});

const createMockRemoteClient = (): SchemaRemoteClient =>
  ({
    fetchSchema: vi.fn(),
    pushMigration: vi.fn(),
    getSyncStatus: vi.fn(),
    healthCheck: vi.fn(),
    clearCache: vi.fn(),
  }) as unknown as SchemaRemoteClient;

const createMockLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

describe('SchemaSyncService', () => {
  let driver: Driver;
  let dialect: Dialect;
  let remoteClient: SchemaRemoteClient;
  let syncService: SchemaSyncService;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    driver = createMockDriver();
    dialect = createMockDialect();
    remoteClient = createMockRemoteClient();
    logger = createMockLogger();
    syncService = new SchemaSyncService(
      driver,
      dialect,
      remoteClient,
      {
        appId: 'test-app',
      },
      logger
    );
  });

  describe('pull', () => {
    it('should pull remote schema and report no differences', async () => {
      vi.mocked(driver.query).mockResolvedValue({ rows: [], rowCount: 0 });
      vi.mocked(remoteClient.fetchSchema).mockResolvedValue({
        schema: { tables: {} },
        version: '1.0.0',
        checksum: 'abc123',
        updatedAt: new Date().toISOString(),
        environment: 'production',
      });

      const result = await syncService.pull();

      expect(result.applied).toBe(false);
      expect(result.diff.hasDifferences).toBe(false);
      expect(logger.info).toHaveBeenCalledWith('Local schema is up to date');
    });

    it('should detect differences and apply changes', async () => {
      vi.mocked(driver.query).mockResolvedValue({ rows: [], rowCount: 0 });
      vi.mocked(remoteClient.fetchSchema).mockResolvedValue({
        schema: {
          tables: {
            users: {
              columns: {
                id: { type: 'uuid', primaryKey: true },
                app_id: { type: 'string', tenant: true },
                organization_id: { type: 'string', tenant: true },
              },
            },
          },
        },
        version: '1.0.0',
        checksum: 'abc123',
        updatedAt: new Date().toISOString(),
        environment: 'production',
      });

      const result = await syncService.pull();

      expect(result.applied).toBe(true);
      expect(result.diff.hasDifferences).toBe(true);
      expect(result.diff.summary.tablesAdded).toBe(1);
    });

    it('should respect dry-run mode', async () => {
      vi.mocked(driver.query).mockResolvedValue({ rows: [], rowCount: 0 });
      vi.mocked(remoteClient.fetchSchema).mockResolvedValue({
        schema: {
          tables: {
            users: {
              columns: {
                id: { type: 'uuid', primaryKey: true },
              },
            },
          },
        },
        version: '1.0.0',
        checksum: 'abc123',
        updatedAt: new Date().toISOString(),
        environment: 'production',
      });

      const result = await syncService.pull({ dryRun: true });

      expect(result.applied).toBe(false);
      expect(result.diff.hasDifferences).toBe(true);
      expect(driver.transaction).not.toHaveBeenCalled();
    });

    it('should throw BreakingChangeError without force flag', async () => {
      vi.mocked(driver.query)
        .mockResolvedValueOnce({
          rows: [{ table_name: 'users' }],
          rowCount: 1,
        })
        .mockResolvedValue({ rows: [], rowCount: 0 });

      vi.mocked(remoteClient.fetchSchema).mockResolvedValue({
        schema: { tables: {} },
        version: '1.0.0',
        checksum: 'abc123',
        updatedAt: new Date().toISOString(),
        environment: 'production',
      });

      await expect(syncService.pull()).rejects.toThrow(BreakingChangeError);
    });

    it('should apply breaking changes with force flag', async () => {
      vi.mocked(driver.query)
        .mockResolvedValueOnce({
          rows: [{ table_name: 'users' }],
          rowCount: 1,
        })
        .mockResolvedValue({ rows: [], rowCount: 0 });

      vi.mocked(remoteClient.fetchSchema).mockResolvedValue({
        schema: { tables: {} },
        version: '1.0.0',
        checksum: 'abc123',
        updatedAt: new Date().toISOString(),
        environment: 'production',
      });

      const result = await syncService.pull({ force: true });

      expect(result.applied).toBe(true);
    });
  });

  describe('push', () => {
    it('should push local schema to remote', async () => {
      vi.mocked(driver.query).mockResolvedValue({ rows: [], rowCount: 0 });
      vi.mocked(remoteClient.fetchSchema).mockResolvedValue({
        schema: { tables: {} },
        version: '1.0.0',
        checksum: 'abc123',
        updatedAt: new Date().toISOString(),
        environment: 'staging',
      });
      vi.mocked(remoteClient.pushMigration).mockResolvedValue({
        success: true,
        applied: true,
      });

      const result = await syncService.push({ environment: 'staging', force: true });

      expect(result.applied).toBe(false);
      expect(result.diff.hasDifferences).toBe(false);
    });

    it('should require force flag for production', async () => {
      vi.mocked(driver.query)
        .mockResolvedValueOnce({ rows: [{ table_name: 'users' }], rowCount: 1 })
        .mockResolvedValue({ rows: [], rowCount: 0 });
      vi.mocked(remoteClient.fetchSchema).mockResolvedValue({
        schema: { tables: {} },
        version: '1.0.0',
        checksum: 'abc123',
        updatedAt: new Date().toISOString(),
        environment: 'production',
      });

      await expect(syncService.push({ environment: 'production' })).rejects.toThrow(
        UserCancelledError
      );
    });
  });

  describe('diff', () => {
    it('should return schema diff', async () => {
      vi.mocked(driver.query).mockResolvedValue({ rows: [], rowCount: 0 });
      vi.mocked(remoteClient.fetchSchema).mockResolvedValue({
        schema: {
          tables: {
            users: {
              columns: {
                id: { type: 'uuid', primaryKey: true },
              },
            },
          },
        },
        version: '1.0.0',
        checksum: 'abc123',
        updatedAt: new Date().toISOString(),
        environment: 'production',
      });

      const diff = await syncService.diff();

      expect(diff.hasDifferences).toBe(true);
      expect(diff.summary.tablesAdded).toBe(1);
    });
  });

  describe('getSyncStatus', () => {
    it('should return null when no sync history', async () => {
      vi.mocked(driver.query).mockResolvedValue({ rows: [], rowCount: 0 });

      const status = await syncService.getSyncStatus();

      expect(status).toBeNull();
    });
  });

  describe('formatDiff', () => {
    it('should format diff in different formats', async () => {
      vi.mocked(driver.query).mockResolvedValue({ rows: [], rowCount: 0 });
      vi.mocked(remoteClient.fetchSchema).mockResolvedValue({
        schema: {
          tables: {
            users: {
              columns: {
                id: { type: 'uuid', primaryKey: true },
              },
            },
          },
        },
        version: '1.0.0',
        checksum: 'abc123',
        updatedAt: new Date().toISOString(),
        environment: 'production',
      });

      const diff = await syncService.diff();

      expect(syncService.formatDiff(diff, 'text')).toContain('Schema Diff');
      expect(syncService.formatDiff(diff, 'json')).toContain('"hasDifferences"');
      expect(syncService.formatDiff(diff, 'sql')).toContain('-- Up');
    });
  });
});
