import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SchemaRemoteClient } from './client.js';
import { SchemaRemoteError, AuthenticationError } from '../schema/types.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('SchemaRemoteClient', () => {
  let client: SchemaRemoteClient;

  beforeEach(() => {
    client = new SchemaRemoteClient({
      apiUrl: 'https://api.launchpad.dev',
      projectId: 'test-project',
      authToken: 'test-token',
    });
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('fetchSchema', () => {
    it('should fetch schema from remote', async () => {
      const mockResponse = {
        schema: { tables: { users: { columns: {} } } },
        version: '1.0.0',
        checksum: 'abc123',
        updatedAt: '2024-01-01T00:00:00Z',
        environment: 'production',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await client.fetchSchema();

      expect(result).toEqual(mockResponse);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.launchpad.dev/v1/projects/test-project/schema',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
            'X-Environment': 'production',
          }),
        })
      );
    });

    it('should use environment header', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ schema: { tables: {} } }),
      });

      await client.fetchSchema('staging');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Environment': 'staging',
          }),
        })
      );
    });

    it('should cache schema responses', async () => {
      const mockResponse = {
        schema: { tables: {} },
        version: '1.0.0',
        checksum: 'abc123',
        updatedAt: '2024-01-01T00:00:00Z',
        environment: 'production',
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      await client.fetchSchema('production');
      await client.fetchSchema('production');

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should throw AuthenticationError on 401', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: () => Promise.resolve('Unauthorized'),
      });

      await expect(client.fetchSchema()).rejects.toThrow(AuthenticationError);
    });

    it('should throw SchemaRemoteError on 403', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        text: () => Promise.resolve('Forbidden'),
      });

      await expect(client.fetchSchema()).rejects.toThrow(SchemaRemoteError);
    });

    it('should throw SchemaRemoteError on 404', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: () => Promise.resolve('Not Found'),
      });

      await expect(client.fetchSchema()).rejects.toThrow(SchemaRemoteError);
    });
  });

  describe('pushMigration', () => {
    it('should push migration to remote', async () => {
      const mockResponse = {
        success: true,
        applied: true,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await client.pushMigration({
        version: '20240101000000',
        name: 'test_migration',
        upSql: ['CREATE TABLE users (...)'],
        downSql: ['DROP TABLE users'],
        checksum: 'abc123',
      });

      expect(result).toEqual(mockResponse);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.launchpad.dev/v1/projects/test-project/schema/migrations',
        expect.objectContaining({
          method: 'POST',
          body: expect.any(String),
        })
      );
    });

    it('should clear cache after push', async () => {
      const schemaResponse = {
        schema: { tables: {} },
        version: '1.0.0',
        checksum: 'abc123',
        updatedAt: '2024-01-01T00:00:00Z',
        environment: 'production',
      };

      const pushResponse = {
        success: true,
        applied: true,
      };

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(schemaResponse),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(pushResponse),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(schemaResponse),
        });

      await client.fetchSchema('production');
      await client.pushMigration(
        {
          version: '20240101000000',
          name: 'test',
          upSql: [],
          downSql: [],
          checksum: 'abc',
        },
        { environment: 'production' }
      );
      await client.fetchSchema('production');

      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  describe('getSyncStatus', () => {
    it('should get sync status from remote', async () => {
      const mockResponse = {
        version: '1.0.0',
        checksum: 'abc123',
        updatedAt: '2024-01-01T00:00:00Z',
        environment: 'production',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await client.getSyncStatus();

      expect(result).toEqual(mockResponse);
    });
  });

  describe('healthCheck', () => {
    it('should check remote health', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'healthy', version: '1.0.0' }),
      });

      const result = await client.healthCheck();

      expect(result.status).toBe('healthy');
    });
  });

  describe('retry logic', () => {
    it('should retry on 5xx errors and eventually succeed', async () => {
      const clientWithNoDelay = new SchemaRemoteClient(
        {
          apiUrl: 'https://api.launchpad.dev',
          projectId: 'test-project',
          authToken: 'test-token',
        },
        { retries: 3, timeout: 30000 }
      );

      let callCount = 0;
      mockFetch.mockImplementation(() => {
        callCount++;
        if (callCount < 3) {
          return Promise.resolve({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
            text: () => Promise.resolve('Error'),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ schema: { tables: {} } }),
        });
      });

      const result = await clientWithNoDelay.fetchSchema();

      expect(callCount).toBe(3);
      expect(result.schema).toBeDefined();
    });

    it('should throw after max retries', async () => {
      const clientWithRetries = new SchemaRemoteClient(
        {
          apiUrl: 'https://api.launchpad.dev',
          projectId: 'test-project',
          authToken: 'test-token',
        },
        { retries: 2, timeout: 30000 }
      );

      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: () => Promise.resolve('Error'),
      });

      await expect(clientWithRetries.fetchSchema()).rejects.toThrow(SchemaRemoteError);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('clearCache', () => {
    it('should clear the schema cache', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ schema: { tables: {} } }),
      });

      await client.fetchSchema();
      client.clearCache();
      await client.fetchSchema();

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});
