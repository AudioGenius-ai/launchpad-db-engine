import type { SchemaDefinition } from '../types/index.js';
import type { MigrationScript } from '../schema/types.js';

export interface RemoteConfig {
  apiUrl: string;
  projectId: string;
  authToken: string;
}

export interface RemoteSchemaResponse {
  schema: SchemaDefinition;
  version: string;
  checksum: string;
  updatedAt: string;
  environment: string;
}

export interface RemotePushOptions {
  environment?: string;
  dryRun?: boolean;
  force?: boolean;
}

export interface RemotePushResult {
  success: boolean;
  applied: boolean;
  migration?: MigrationScript;
  errors?: string[];
  warnings?: string[];
}

export interface RemoteSyncStatus {
  version: string;
  checksum: string;
  updatedAt: string;
  environment: string;
}

export interface RemoteHealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  version: string;
}

export interface RemoteApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}
