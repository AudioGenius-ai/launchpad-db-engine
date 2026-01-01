import type { Driver } from '../driver/types.js';
import type { Dialect } from '../migrations/dialects/types.js';
import type { SyncStatus } from './types.js';

export interface SyncMetadataOptions {
  tableName?: string;
}

export class SyncMetadataManager {
  private tableName: string;

  constructor(
    private driver: Driver,
    private dialect: Dialect,
    options: SyncMetadataOptions = {}
  ) {
    this.tableName = options.tableName ?? 'lp_schema_sync';
  }

  async ensureSyncTable(): Promise<void> {
    let sql: string;

    if (this.dialect.name === 'postgresql') {
      sql = `
        CREATE TABLE IF NOT EXISTS "${this.tableName}" (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          app_id TEXT NOT NULL,
          table_name TEXT NOT NULL,
          local_checksum TEXT,
          local_version TEXT,
          local_updated_at TIMESTAMPTZ,
          remote_checksum TEXT,
          remote_version TEXT,
          remote_updated_at TIMESTAMPTZ,
          sync_status TEXT NOT NULL DEFAULT 'unknown',
          last_sync_at TIMESTAMPTZ,
          last_sync_direction TEXT,
          last_sync_by TEXT,
          base_checksum TEXT,
          conflict_details JSONB,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(app_id, table_name)
        )
      `;
    } else if (this.dialect.name === 'mysql') {
      sql = `
        CREATE TABLE IF NOT EXISTS \`${this.tableName}\` (
          id CHAR(36) PRIMARY KEY,
          app_id VARCHAR(255) NOT NULL,
          table_name VARCHAR(255) NOT NULL,
          local_checksum VARCHAR(64),
          local_version VARCHAR(50),
          local_updated_at DATETIME,
          remote_checksum VARCHAR(64),
          remote_version VARCHAR(50),
          remote_updated_at DATETIME,
          sync_status VARCHAR(20) NOT NULL DEFAULT 'unknown',
          last_sync_at DATETIME,
          last_sync_direction VARCHAR(10),
          last_sync_by VARCHAR(255),
          base_checksum VARCHAR(64),
          conflict_details JSON,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY unique_app_table (app_id, table_name)
        )
      `;
    } else {
      sql = `
        CREATE TABLE IF NOT EXISTS "${this.tableName}" (
          id TEXT PRIMARY KEY,
          app_id TEXT NOT NULL,
          table_name TEXT NOT NULL,
          local_checksum TEXT,
          local_version TEXT,
          local_updated_at TEXT,
          remote_checksum TEXT,
          remote_version TEXT,
          remote_updated_at TEXT,
          sync_status TEXT NOT NULL DEFAULT 'unknown',
          last_sync_at TEXT,
          last_sync_direction TEXT,
          last_sync_by TEXT,
          base_checksum TEXT,
          conflict_details TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          UNIQUE(app_id, table_name)
        )
      `;
    }

    await this.driver.execute(sql);

    if (this.dialect.name === 'postgresql') {
      await this.driver
        .execute(`
        CREATE INDEX IF NOT EXISTS idx_${this.tableName}_status
        ON "${this.tableName}"(app_id, sync_status)
      `)
        .catch(() => {});
    }
  }

  async getSyncState(appId: string, tableName: string): Promise<SyncStatus | null> {
    let sql: string;
    let params: unknown[];

    if (this.dialect.name === 'postgresql') {
      sql = `SELECT * FROM "${this.tableName}" WHERE app_id = $1 AND table_name = $2`;
      params = [appId, tableName];
    } else {
      sql = `SELECT * FROM ${this.dialect.name === 'mysql' ? `\`${this.tableName}\`` : `"${this.tableName}"`} WHERE app_id = ? AND table_name = ?`;
      params = [appId, tableName];
    }

    const result = await this.driver.query<{
      app_id: string;
      table_name: string;
      local_checksum: string | null;
      local_version: string | null;
      local_updated_at: Date | string | null;
      remote_checksum: string | null;
      remote_version: string | null;
      remote_updated_at: Date | string | null;
      sync_status: string;
      last_sync_at: Date | string | null;
      last_sync_direction: string | null;
      last_sync_by: string | null;
      base_checksum: string | null;
      conflict_details: Record<string, unknown> | string | null;
    }>(sql, params);

    if (!result.rows.length) return null;

    const row = result.rows[0];

    return {
      appId: row.app_id,
      tableName: row.table_name,
      localChecksum: row.local_checksum,
      localVersion: row.local_version,
      localUpdatedAt: row.local_updated_at ? new Date(row.local_updated_at) : null,
      remoteChecksum: row.remote_checksum,
      remoteVersion: row.remote_version,
      remoteUpdatedAt: row.remote_updated_at ? new Date(row.remote_updated_at) : null,
      syncStatus: row.sync_status as SyncStatus['syncStatus'],
      lastSyncAt: row.last_sync_at ? new Date(row.last_sync_at) : null,
      lastSyncDirection: row.last_sync_direction as SyncStatus['lastSyncDirection'],
      lastSyncBy: row.last_sync_by,
      baseChecksum: row.base_checksum,
      conflictDetails:
        typeof row.conflict_details === 'string'
          ? JSON.parse(row.conflict_details)
          : row.conflict_details,
    };
  }

  async getAllSyncStates(appId: string): Promise<SyncStatus[]> {
    let sql: string;
    let params: unknown[];

    if (this.dialect.name === 'postgresql') {
      sql = `SELECT * FROM "${this.tableName}" WHERE app_id = $1 ORDER BY table_name`;
      params = [appId];
    } else {
      sql = `SELECT * FROM ${this.dialect.name === 'mysql' ? `\`${this.tableName}\`` : `"${this.tableName}"`} WHERE app_id = ? ORDER BY table_name`;
      params = [appId];
    }

    const result = await this.driver.query<{
      app_id: string;
      table_name: string;
      local_checksum: string | null;
      local_version: string | null;
      local_updated_at: Date | string | null;
      remote_checksum: string | null;
      remote_version: string | null;
      remote_updated_at: Date | string | null;
      sync_status: string;
      last_sync_at: Date | string | null;
      last_sync_direction: string | null;
      last_sync_by: string | null;
      base_checksum: string | null;
      conflict_details: Record<string, unknown> | string | null;
    }>(sql, params);

    return result.rows.map((row) => ({
      appId: row.app_id,
      tableName: row.table_name,
      localChecksum: row.local_checksum,
      localVersion: row.local_version,
      localUpdatedAt: row.local_updated_at ? new Date(row.local_updated_at) : null,
      remoteChecksum: row.remote_checksum,
      remoteVersion: row.remote_version,
      remoteUpdatedAt: row.remote_updated_at ? new Date(row.remote_updated_at) : null,
      syncStatus: row.sync_status as SyncStatus['syncStatus'],
      lastSyncAt: row.last_sync_at ? new Date(row.last_sync_at) : null,
      lastSyncDirection: row.last_sync_direction as SyncStatus['lastSyncDirection'],
      lastSyncBy: row.last_sync_by,
      baseChecksum: row.base_checksum,
      conflictDetails:
        typeof row.conflict_details === 'string'
          ? JSON.parse(row.conflict_details)
          : row.conflict_details,
    }));
  }

  async updateSyncState(
    appId: string,
    direction: 'push' | 'pull',
    data: {
      localChecksum?: string;
      localVersion?: string;
      remoteChecksum?: string;
      remoteVersion?: string;
      syncBy?: string;
    }
  ): Promise<void> {
    const now = new Date().toISOString();
    const status = 'synced';

    if (this.dialect.name === 'postgresql') {
      await this.driver.execute(
        `
        INSERT INTO "${this.tableName}" (
          app_id, table_name, local_checksum, local_version, local_updated_at,
          remote_checksum, remote_version, remote_updated_at, sync_status,
          last_sync_at, last_sync_direction, last_sync_by, base_checksum
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (app_id, table_name) DO UPDATE SET
          local_checksum = COALESCE($3, "${this.tableName}".local_checksum),
          local_version = COALESCE($4, "${this.tableName}".local_version),
          local_updated_at = $5,
          remote_checksum = COALESCE($6, "${this.tableName}".remote_checksum),
          remote_version = COALESCE($7, "${this.tableName}".remote_version),
          remote_updated_at = $8,
          sync_status = $9,
          last_sync_at = $10,
          last_sync_direction = $11,
          last_sync_by = $12,
          base_checksum = COALESCE($13, "${this.tableName}".base_checksum),
          updated_at = NOW()
        `,
        [
          appId,
          '__global__',
          data.localChecksum ?? null,
          data.localVersion ?? null,
          now,
          data.remoteChecksum ?? null,
          data.remoteVersion ?? null,
          now,
          status,
          now,
          direction,
          data.syncBy ?? null,
          data.localChecksum ?? data.remoteChecksum ?? null,
        ]
      );
    } else if (this.dialect.name === 'mysql') {
      const id = this.generateUUID();
      await this.driver.execute(
        `
        INSERT INTO \`${this.tableName}\` (
          id, app_id, table_name, local_checksum, local_version, local_updated_at,
          remote_checksum, remote_version, remote_updated_at, sync_status,
          last_sync_at, last_sync_direction, last_sync_by, base_checksum
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          local_checksum = COALESCE(VALUES(local_checksum), local_checksum),
          local_version = COALESCE(VALUES(local_version), local_version),
          local_updated_at = VALUES(local_updated_at),
          remote_checksum = COALESCE(VALUES(remote_checksum), remote_checksum),
          remote_version = COALESCE(VALUES(remote_version), remote_version),
          remote_updated_at = VALUES(remote_updated_at),
          sync_status = VALUES(sync_status),
          last_sync_at = VALUES(last_sync_at),
          last_sync_direction = VALUES(last_sync_direction),
          last_sync_by = VALUES(last_sync_by),
          base_checksum = COALESCE(VALUES(base_checksum), base_checksum)
        `,
        [
          id,
          appId,
          '__global__',
          data.localChecksum ?? null,
          data.localVersion ?? null,
          now,
          data.remoteChecksum ?? null,
          data.remoteVersion ?? null,
          now,
          status,
          now,
          direction,
          data.syncBy ?? null,
          data.localChecksum ?? data.remoteChecksum ?? null,
        ]
      );
    } else {
      const id = this.generateUUID();
      await this.driver.execute(
        `
        INSERT OR REPLACE INTO "${this.tableName}" (
          id, app_id, table_name, local_checksum, local_version, local_updated_at,
          remote_checksum, remote_version, remote_updated_at, sync_status,
          last_sync_at, last_sync_direction, last_sync_by, base_checksum,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        `,
        [
          id,
          appId,
          '__global__',
          data.localChecksum ?? null,
          data.localVersion ?? null,
          now,
          data.remoteChecksum ?? null,
          data.remoteVersion ?? null,
          now,
          status,
          now,
          direction,
          data.syncBy ?? null,
          data.localChecksum ?? data.remoteChecksum ?? null,
        ]
      );
    }
  }

  async markConflict(
    appId: string,
    tableName: string,
    conflictDetails: Record<string, unknown>
  ): Promise<void> {
    const detailsJson = JSON.stringify(conflictDetails);

    if (this.dialect.name === 'postgresql') {
      await this.driver.execute(
        `
        UPDATE "${this.tableName}"
        SET sync_status = 'conflict', conflict_details = $1, updated_at = NOW()
        WHERE app_id = $2 AND table_name = $3
        `,
        [detailsJson, appId, tableName]
      );
    } else {
      const table = this.dialect.name === 'mysql' ? `\`${this.tableName}\`` : `"${this.tableName}"`;
      await this.driver.execute(
        `UPDATE ${table} SET sync_status = 'conflict', conflict_details = ? WHERE app_id = ? AND table_name = ?`,
        [detailsJson, appId, tableName]
      );
    }
  }

  async detectConflicts(appId: string): Promise<SyncStatus[]> {
    const states = await this.getAllSyncStates(appId);

    return states.filter((state) => {
      if (!state.localChecksum || !state.remoteChecksum || !state.baseChecksum) {
        return false;
      }

      const localChanged = state.localChecksum !== state.baseChecksum;
      const remoteChanged = state.remoteChecksum !== state.baseChecksum;

      return localChanged && remoteChanged && state.localChecksum !== state.remoteChecksum;
    });
  }

  private generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
}

export function createSyncMetadataManager(
  driver: Driver,
  dialect: Dialect,
  options?: SyncMetadataOptions
): SyncMetadataManager {
  return new SyncMetadataManager(driver, dialect, options);
}
