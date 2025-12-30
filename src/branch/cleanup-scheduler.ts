import type { Driver } from '../driver/types.js';
import type { Branch, BranchRow, CleanupResult } from './types.js';

export interface CleanupSchedulerOptions {
  driver: Driver;
  intervalMs?: number;
  defaultMaxAgeDays?: number;
  skipProtected?: boolean;
  metadataTable?: string;
  onCleanup?: (result: CleanupResult) => void;
  onError?: (error: Error) => void;
}

export interface CleanupJob {
  id: string;
  startedAt: Date;
  completedAt?: Date;
  result?: CleanupResult;
  error?: string;
}

export class CleanupScheduler {
  private driver: Driver;
  private intervalMs: number;
  private defaultMaxAgeDays: number;
  private skipProtected: boolean;
  private metadataTable: string;
  private onCleanup?: (result: CleanupResult) => void;
  private onError?: (error: Error) => void;

  private intervalId: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private lastRun: CleanupJob | null = null;
  private history: CleanupJob[] = [];

  constructor(options: CleanupSchedulerOptions) {
    this.driver = options.driver;
    this.intervalMs = options.intervalMs ?? 24 * 60 * 60 * 1000; // 24 hours
    this.defaultMaxAgeDays = options.defaultMaxAgeDays ?? 7;
    this.skipProtected = options.skipProtected ?? true;
    this.metadataTable = options.metadataTable ?? 'lp_branch_metadata';
    this.onCleanup = options.onCleanup;
    this.onError = options.onError;
  }

  start(): void {
    if (this.intervalId) {
      return;
    }

    this.runCleanup().catch((error) => {
      if (this.onError) {
        this.onError(error instanceof Error ? error : new Error(String(error)));
      }
    });

    this.intervalId = setInterval(() => {
      this.runCleanup().catch((error) => {
        if (this.onError) {
          this.onError(error instanceof Error ? error : new Error(String(error)));
        }
      });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  isScheduled(): boolean {
    return this.intervalId !== null;
  }

  isCurrentlyRunning(): boolean {
    return this.isRunning;
  }

  getLastRun(): CleanupJob | null {
    return this.lastRun;
  }

  getHistory(limit = 10): CleanupJob[] {
    return this.history.slice(-limit);
  }

  async runCleanup(options?: {
    maxAgeDays?: number;
    dryRun?: boolean;
  }): Promise<CleanupResult> {
    if (this.isRunning) {
      throw new Error('Cleanup is already running');
    }

    this.isRunning = true;
    const job: CleanupJob = {
      id: this.generateJobId(),
      startedAt: new Date(),
    };

    try {
      const result = await this.executeCleanup(options);
      this.recordSuccess(job, result);
      return result;
    } catch (error) {
      this.recordError(job, error);
      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  private async executeCleanup(options?: {
    maxAgeDays?: number;
    dryRun?: boolean;
  }): Promise<CleanupResult> {
    const maxAge = options?.maxAgeDays ?? this.defaultMaxAgeDays;
    const staleBranches = await this.getStaleBranches(maxAge);
    const deleted: string[] = [];
    const skipped: string[] = [];

    for (const branch of staleBranches) {
      if (options?.dryRun) {
        deleted.push(branch.slug);
        continue;
      }
      await this.tryDeleteBranch(branch, deleted, skipped);
    }

    return { deleted, skipped };
  }

  private async tryDeleteBranch(
    branch: Branch,
    deleted: string[],
    skipped: string[]
  ): Promise<void> {
    try {
      await this.deleteBranch(branch);
      deleted.push(branch.slug);
    } catch (error) {
      skipped.push(`${branch.slug}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private recordSuccess(job: CleanupJob, result: CleanupResult): void {
    job.completedAt = new Date();
    job.result = result;
    this.lastRun = job;
    this.history.push(job);

    if (this.history.length > 100) {
      this.history = this.history.slice(-100);
    }

    if (this.onCleanup) {
      this.onCleanup(result);
    }
  }

  private recordError(job: CleanupJob, error: unknown): void {
    job.completedAt = new Date();
    job.error = error instanceof Error ? error.message : String(error);
    this.lastRun = job;
    this.history.push(job);

    if (this.onError) {
      this.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async getStaleBranches(maxAgeDays: number): Promise<Branch[]> {
    let sql = `
      SELECT * FROM ${this.quoteIdent(this.metadataTable)}
      WHERE deleted_at IS NULL
        AND last_accessed_at < NOW() - INTERVAL '${maxAgeDays} days'
        AND status != 'deleting'
    `;

    if (this.skipProtected) {
      sql += ` AND is_protected = FALSE AND status != 'protected'`;
    }

    sql += ' ORDER BY last_accessed_at ASC';

    const result = await this.driver.query<BranchRow>(sql);
    return result.rows.map((row) => this.mapBranchRow(row));
  }

  async markAsStale(maxAgeDays: number): Promise<number> {
    let sql = `
      UPDATE ${this.quoteIdent(this.metadataTable)}
      SET status = 'stale'
      WHERE deleted_at IS NULL
        AND last_accessed_at < NOW() - INTERVAL '${maxAgeDays} days'
        AND status = 'active'
    `;

    if (this.skipProtected) {
      sql += ' AND is_protected = FALSE';
    }

    const result = await this.driver.execute(sql);
    return result.rowCount;
  }

  async getUpcomingCleanups(
    daysAhead = 7
  ): Promise<{ branch: Branch; daysUntilCleanup: number }[]> {
    const sql = `
      SELECT *,
        EXTRACT(DAY FROM (last_accessed_at + (auto_delete_days * INTERVAL '1 day') - NOW())) as days_until_cleanup
      FROM ${this.quoteIdent(this.metadataTable)}
      WHERE deleted_at IS NULL
        AND status != 'protected'
        AND status != 'deleting'
        AND is_protected = FALSE
        AND last_accessed_at + (auto_delete_days * INTERVAL '1 day') < NOW() + INTERVAL '${daysAhead} days'
      ORDER BY days_until_cleanup ASC
    `;

    const result = await this.driver.query<BranchRow & { days_until_cleanup: string }>(sql);

    return result.rows.map((row) => ({
      branch: this.mapBranchRow(row),
      daysUntilCleanup: Number.parseFloat(row.days_until_cleanup),
    }));
  }

  private async deleteBranch(branch: Branch): Promise<void> {
    await this.driver.transaction(async (trx) => {
      await trx.execute(
        `
        UPDATE ${this.quoteIdent(this.metadataTable)}
        SET status = 'deleting', deleted_at = NOW()
        WHERE id = $1
      `,
        [branch.id]
      );

      await trx.execute(`DROP SCHEMA IF EXISTS ${this.quoteIdent(branch.schemaName)} CASCADE`);

      await trx.execute(
        `
        DELETE FROM ${this.quoteIdent(this.metadataTable)} WHERE id = $1
      `,
        [branch.id]
      );
    });
  }

  private generateJobId(): string {
    return `cleanup_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }

  private quoteIdent(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  private mapBranchRow(row: BranchRow): Branch {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      schemaName: row.schema_name,
      parentBranchId: row.parent_branch_id,
      gitBranch: row.git_branch,
      prNumber: row.pr_number,
      prUrl: row.pr_url,
      status: row.status,
      isProtected: row.is_protected,
      createdAt: new Date(row.created_at),
      createdBy: row.created_by,
      lastAccessedAt: new Date(row.last_accessed_at),
      deletedAt: row.deleted_at ? new Date(row.deleted_at) : null,
      migrationCount: row.migration_count,
      tableCount: row.table_count,
      storageBytes:
        typeof row.storage_bytes === 'string'
          ? Number.parseInt(row.storage_bytes, 10)
          : row.storage_bytes,
      autoDeleteDays: row.auto_delete_days,
      copyData: row.copy_data,
      piiMasking: row.pii_masking,
    };
  }
}

export function createCleanupScheduler(options: CleanupSchedulerOptions): CleanupScheduler {
  return new CleanupScheduler(options);
}
