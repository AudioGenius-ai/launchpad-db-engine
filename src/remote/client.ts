import type { MigrationScript } from '../schema/types.js';
import { AuthenticationError, SchemaRemoteError } from '../schema/types.js';
import type {
  RemoteConfig,
  RemoteHealthResponse,
  RemotePushOptions,
  RemotePushResult,
  RemoteSchemaResponse,
  RemoteSyncStatus,
} from './types.js';

export interface SchemaRemoteClientOptions {
  timeout?: number;
  retries?: number;
}

export class SchemaRemoteClient {
  private apiUrl: string;
  private projectId: string;
  private authToken: string;
  private timeout: number;
  private retries: number;

  private schemaCache: Map<string, { schema: RemoteSchemaResponse; cachedAt: number }> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000;

  constructor(config: RemoteConfig, options: SchemaRemoteClientOptions = {}) {
    this.apiUrl = config.apiUrl.replace(/\/$/, '');
    this.projectId = config.projectId;
    this.authToken = config.authToken;
    this.timeout = options.timeout ?? 30000;
    this.retries = options.retries ?? 3;
  }

  async fetchSchema(environment = 'production'): Promise<RemoteSchemaResponse> {
    const cacheKey = `${this.projectId}-${environment}`;
    const cached = this.schemaCache.get(cacheKey);

    if (cached && Date.now() - cached.cachedAt < this.CACHE_TTL) {
      return cached.schema;
    }

    const response = await this.request<RemoteSchemaResponse>(
      'GET',
      `/v1/projects/${this.projectId}/schema`,
      undefined,
      { 'X-Environment': environment }
    );

    this.schemaCache.set(cacheKey, {
      schema: response,
      cachedAt: Date.now(),
    });

    return response;
  }

  async pushMigration(
    migration: MigrationScript,
    options: RemotePushOptions = {}
  ): Promise<RemotePushResult> {
    const environment = options.environment ?? 'production';

    this.schemaCache.delete(`${this.projectId}-${environment}`);

    return this.request<RemotePushResult>(
      'POST',
      `/v1/projects/${this.projectId}/schema/migrations`,
      {
        migration,
        dryRun: options.dryRun ?? false,
        force: options.force ?? false,
      },
      { 'X-Environment': environment }
    );
  }

  async getSyncStatus(environment = 'production'): Promise<RemoteSyncStatus> {
    return this.request<RemoteSyncStatus>(
      'GET',
      `/v1/projects/${this.projectId}/schema/sync-status`,
      undefined,
      { 'X-Environment': environment }
    );
  }

  async healthCheck(): Promise<RemoteHealthResponse> {
    return this.request<RemoteHealthResponse>('GET', '/v1/health');
  }

  clearCache(): void {
    this.schemaCache.clear();
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    additionalHeaders?: Record<string, string>
  ): Promise<T> {
    const url = `${this.apiUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.authToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...additionalHeaders,
    };

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        const response = await fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          if (response.status === 401) {
            throw new AuthenticationError('Invalid or expired authentication token.');
          }

          if (response.status === 403) {
            throw new SchemaRemoteError('Permission denied. Check your API key permissions.', 403);
          }

          if (response.status === 404) {
            throw new SchemaRemoteError(`Project not found: ${this.projectId}`, 404);
          }

          if (response.status >= 500 && attempt < this.retries - 1) {
            await this.delay(2 ** attempt * 1000);
            continue;
          }

          const errorBody = await response.text();
          let errorMessage: string;

          try {
            const parsed = JSON.parse(errorBody);
            errorMessage = parsed.message || parsed.error || errorBody;
          } catch {
            errorMessage = errorBody || response.statusText;
          }

          throw new SchemaRemoteError(errorMessage, response.status);
        }

        return (await response.json()) as T;
      } catch (error) {
        if (error instanceof AuthenticationError || error instanceof SchemaRemoteError) {
          throw error;
        }

        lastError = error instanceof Error ? error : new Error(String(error));

        if (error instanceof Error && error.name === 'AbortError') {
          lastError = new SchemaRemoteError(`Request timeout after ${this.timeout}ms`);
        }

        if (attempt < this.retries - 1) {
          await this.delay(2 ** attempt * 1000);
        }
      }
    }

    throw lastError ?? new SchemaRemoteError('Request failed after retries');
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export function createSchemaRemoteClient(
  config: RemoteConfig,
  options?: SchemaRemoteClientOptions
): SchemaRemoteClient {
  return new SchemaRemoteClient(config, options);
}
