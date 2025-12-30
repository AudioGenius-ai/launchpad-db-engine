import type { Driver } from '../driver/types.js';
import { getDialect } from '../migrations/dialects/index.js';
import type { Dialect } from '../migrations/dialects/types.js';
import type { SeedResult } from './base.js';

export interface SeedTrackerOptions {
  tableName?: string;
}

export interface SeedRecord {
  id: number;
  name: string;
  version: number;
  executed_at: Date;
  execution_time_ms: number;
  record_count: number;
  checksum?: string;
}

export class SeedTracker {
  private driver: Driver;
  private dialect: Dialect;
  private tableName: string;

  constructor(driver: Driver, options: SeedTrackerOptions = {}) {
    this.driver = driver;
    this.dialect = getDialect(driver.dialect);
    this.tableName = options.tableName ?? 'lp_seeds';
  }

  async ensureTable(): Promise<void> {
    const sql =
      this.dialect.name === 'postgresql'
        ? `
        CREATE TABLE IF NOT EXISTS "${this.tableName}" (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          executed_at TIMESTAMPTZ DEFAULT NOW(),
          execution_time_ms INTEGER,
          record_count INTEGER,
          checksum VARCHAR(64),
          UNIQUE(name, version)
        )
      `
        : this.dialect.name === 'mysql'
          ? `
          CREATE TABLE IF NOT EXISTS \`${this.tableName}\` (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            version INT NOT NULL DEFAULT 1,
            executed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            execution_time_ms INT,
            record_count INT,
            checksum VARCHAR(64),
            UNIQUE KEY unique_name_version (name, version)
          )
        `
          : `
          CREATE TABLE IF NOT EXISTS "${this.tableName}" (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            executed_at TEXT DEFAULT (datetime('now')),
            execution_time_ms INTEGER,
            record_count INTEGER,
            checksum TEXT,
            UNIQUE(name, version)
          )
        `;

    await this.driver.execute(sql);
  }

  async hasRun(name: string, version: number): Promise<boolean> {
    const sql =
      this.dialect.name === 'postgresql'
        ? `SELECT 1 FROM "${this.tableName}" WHERE name = $1 AND version = $2`
        : `SELECT 1 FROM ${this.dialect.name === 'mysql' ? `\`${this.tableName}\`` : `"${this.tableName}"`} WHERE name = ? AND version = ?`;

    const params = [name, version];
    const result = await this.driver.query(sql, params);
    return result.rows.length > 0;
  }

  async record(name: string, version: number, result: SeedResult, duration: number): Promise<void> {
    const sql =
      this.dialect.name === 'postgresql'
        ? `
        INSERT INTO "${this.tableName}" (name, version, execution_time_ms, record_count)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (name, version) DO UPDATE SET
          execution_time_ms = EXCLUDED.execution_time_ms,
          record_count = EXCLUDED.record_count,
          executed_at = NOW()
      `
        : this.dialect.name === 'mysql'
          ? `
          INSERT INTO \`${this.tableName}\` (name, version, execution_time_ms, record_count)
          VALUES (?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            execution_time_ms = VALUES(execution_time_ms),
            record_count = VALUES(record_count),
            executed_at = CURRENT_TIMESTAMP
        `
          : `
          INSERT OR REPLACE INTO "${this.tableName}" (name, version, execution_time_ms, record_count)
          VALUES (?, ?, ?, ?)
        `;

    const params = [name, version, duration, result.count];
    await this.driver.execute(sql, params);
  }

  async remove(name: string): Promise<void> {
    const sql =
      this.dialect.name === 'postgresql'
        ? `DELETE FROM "${this.tableName}" WHERE name = $1`
        : `DELETE FROM ${this.dialect.name === 'mysql' ? `\`${this.tableName}\`` : `"${this.tableName}"`} WHERE name = ?`;

    await this.driver.execute(sql, [name]);
  }

  async clear(): Promise<void> {
    const sql =
      this.dialect.name === 'mysql'
        ? `TRUNCATE TABLE \`${this.tableName}\``
        : `DELETE FROM "${this.tableName}"`;

    await this.driver.execute(sql);
  }

  async list(): Promise<SeedRecord[]> {
    const sql =
      this.dialect.name === 'postgresql'
        ? `SELECT * FROM "${this.tableName}" ORDER BY executed_at DESC`
        : `SELECT * FROM ${this.dialect.name === 'mysql' ? `\`${this.tableName}\`` : `"${this.tableName}"`} ORDER BY executed_at DESC`;

    const result = await this.driver.query<SeedRecord>(sql);
    return result.rows;
  }
}
