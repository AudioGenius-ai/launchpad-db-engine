import type { Driver, TransactionClient } from '../driver/types.js';
import { MigrationMerger } from './migration-merger.js';
import { SchemaDiffer } from './schema-differ.js';
import type {
  Branch,
  BranchRow,
  BranchStatus,
  CleanupOptions,
  CleanupResult,
  CreateBranchOptions,
  ListBranchesFilter,
  MergeOptions,
  MergeResult,
  SchemaDiff,
  SwitchBranchResult,
} from './types.js';

export interface BranchManagerOptions {
  driver: Driver;
  mainSchemaName?: string;
  branchPrefix?: string;
  defaultAutoDeleteDays?: number;
  metadataTableName?: string;
}

export class BranchManager {
  private driver: Driver;
  private mainSchema: string;
  private branchPrefix: string;
  private defaultAutoDeleteDays: number;
  private metadataTable: string;

  constructor(options: BranchManagerOptions) {
    this.driver = options.driver;
    this.mainSchema = options.mainSchemaName ?? 'public';
    this.branchPrefix = options.branchPrefix ?? 'branch_';
    this.defaultAutoDeleteDays = options.defaultAutoDeleteDays ?? 7;
    this.metadataTable = options.metadataTableName ?? 'lp_branch_metadata';
  }

  async ensureMetadataTable(): Promise<void> {
    await this.driver.execute(`
      CREATE TABLE IF NOT EXISTS ${this.quoteIdent(this.metadataTable)} (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(128) NOT NULL,
        slug VARCHAR(128) NOT NULL UNIQUE,
        schema_name VARCHAR(128) NOT NULL UNIQUE,
        parent_branch_id UUID REFERENCES ${this.quoteIdent(this.metadataTable)}(id),

        git_branch VARCHAR(256),
        pr_number INTEGER,
        pr_url TEXT,

        status VARCHAR(20) NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'protected', 'stale', 'deleting')),
        is_protected BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by VARCHAR(256),
        last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ,

        migration_count INTEGER DEFAULT 0,
        table_count INTEGER DEFAULT 0,
        storage_bytes BIGINT DEFAULT 0,

        auto_delete_days INTEGER DEFAULT 7,
        copy_data BOOLEAN DEFAULT FALSE,
        pii_masking BOOLEAN DEFAULT TRUE
      )
    `);

    await this.driver.execute(`
      CREATE INDEX IF NOT EXISTS idx_${this.metadataTable}_status
      ON ${this.quoteIdent(this.metadataTable)}(status)
    `);

    await this.driver.execute(`
      CREATE INDEX IF NOT EXISTS idx_${this.metadataTable}_parent
      ON ${this.quoteIdent(this.metadataTable)}(parent_branch_id)
    `);

    await this.driver.execute(`
      CREATE INDEX IF NOT EXISTS idx_${this.metadataTable}_pr
      ON ${this.quoteIdent(this.metadataTable)}(pr_number)
    `);

    await this.driver.execute(`
      CREATE INDEX IF NOT EXISTS idx_${this.metadataTable}_accessed
      ON ${this.quoteIdent(this.metadataTable)}(last_accessed_at)
    `);
  }

  async createBranch(options: CreateBranchOptions): Promise<Branch> {
    await this.ensureMetadataTable();

    const slug = this.generateSlug(options.name);
    const schemaName = `${this.branchPrefix}${slug}`;

    const existing = await this.getBranchBySlug(slug);
    if (existing) {
      throw new Error(`Branch '${slug}' already exists`);
    }

    const parentBranch = options.parentBranch
      ? await this.getBranchBySlug(options.parentBranch)
      : null;

    const parentSchema = parentBranch?.schemaName ?? this.mainSchema;

    return await this.driver.transaction(async (trx) => {
      await trx.execute(`CREATE SCHEMA IF NOT EXISTS ${this.quoteIdent(schemaName)}`);

      await this.cloneSchemaStructure(trx, parentSchema, schemaName);

      if (options.copyData) {
        await this.copyDataWithMasking(trx, parentSchema, schemaName, options.piiMasking ?? true);
      }

      const tableCount = await this.getTableCount(trx, schemaName);

      const result = await trx.query<BranchRow>(
        `
        INSERT INTO ${this.quoteIdent(this.metadataTable)} (
          name, slug, schema_name, parent_branch_id,
          git_branch, pr_number, pr_url,
          auto_delete_days, copy_data, pii_masking, created_by, table_count
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING *
      `,
        [
          options.name,
          slug,
          schemaName,
          parentBranch?.id ?? null,
          options.gitBranch ?? null,
          options.prNumber ?? null,
          options.prUrl ?? null,
          options.autoDeleteDays ?? this.defaultAutoDeleteDays,
          options.copyData ?? false,
          options.piiMasking ?? true,
          options.createdBy ?? null,
          tableCount,
        ]
      );

      return this.mapBranchRow(result.rows[0]);
    });
  }

  async getBranchBySlug(slug: string): Promise<Branch | null> {
    const result = await this.driver.query<BranchRow>(
      `
      SELECT * FROM ${this.quoteIdent(this.metadataTable)}
      WHERE slug = $1 AND deleted_at IS NULL
    `,
      [slug]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapBranchRow(result.rows[0]);
  }

  async getBranchById(id: string): Promise<Branch | null> {
    const result = await this.driver.query<BranchRow>(
      `
      SELECT * FROM ${this.quoteIdent(this.metadataTable)}
      WHERE id = $1 AND deleted_at IS NULL
    `,
      [id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapBranchRow(result.rows[0]);
  }

  async deleteBranch(branchSlug: string, force = false): Promise<void> {
    const branch = await this.getBranchBySlug(branchSlug);
    if (!branch) {
      throw new Error(`Branch '${branchSlug}' not found`);
    }

    if (branch.isProtected && !force) {
      throw new Error(`Branch '${branchSlug}' is protected. Use force=true to delete.`);
    }

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

  async switchBranch(branchSlug: string): Promise<SwitchBranchResult> {
    const branch = await this.getBranchBySlug(branchSlug);
    if (!branch) {
      throw new Error(`Branch '${branchSlug}' not found`);
    }

    await this.driver.execute(
      `
      UPDATE ${this.quoteIdent(this.metadataTable)}
      SET last_accessed_at = NOW()
      WHERE id = $1
    `,
      [branch.id]
    );

    const searchPath = `${branch.schemaName}, public`;

    return {
      connectionString: this.generateConnectionString(branch),
      searchPath,
      schemaName: branch.schemaName,
    };
  }

  async diffBranches(sourceBranch: string, targetBranch: string): Promise<SchemaDiff> {
    const source = await this.resolveSchemaName(sourceBranch);
    const target = await this.resolveSchemaName(targetBranch);

    const differ = new SchemaDiffer(this.driver);
    return differ.diff(source, target);
  }

  async mergeBranch(options: MergeOptions): Promise<MergeResult> {
    const merger = new MigrationMerger(this.driver, {
      mainSchema: this.mainSchema,
      branchPrefix: this.branchPrefix,
    });

    const result = await merger.merge(options);

    if (result.success && options.deleteSourceAfterMerge) {
      await this.deleteBranch(options.sourceBranch, true);
    }

    return result;
  }

  async listBranches(filter?: ListBranchesFilter): Promise<Branch[]> {
    await this.ensureMetadataTable();

    let sql = `SELECT * FROM ${this.quoteIdent(this.metadataTable)} WHERE deleted_at IS NULL`;
    const params: unknown[] = [];
    let paramIndex = 1;

    if (filter?.status) {
      sql += ` AND status = $${paramIndex++}`;
      params.push(filter.status);
    }

    if (filter?.parentId) {
      sql += ` AND parent_branch_id = $${paramIndex++}`;
      params.push(filter.parentId);
    }

    if (filter?.staleDays) {
      sql += ` AND last_accessed_at < NOW() - INTERVAL '${filter.staleDays} days'`;
    }

    sql += ' ORDER BY created_at DESC';

    const result = await this.driver.query<BranchRow>(sql, params);
    return result.rows.map((row) => this.mapBranchRow(row));
  }

  async cleanupStaleBranches(options: CleanupOptions = {}): Promise<CleanupResult> {
    await this.ensureMetadataTable();

    const maxAge = options.maxAgeDays ?? 7;
    const skipProtected = options.skipProtected ?? true;

    let sql = `
      SELECT * FROM ${this.quoteIdent(this.metadataTable)}
      WHERE deleted_at IS NULL
        AND last_accessed_at < NOW() - INTERVAL '${maxAge} days'
        AND status != 'deleting'
    `;

    if (skipProtected) {
      sql += ` AND is_protected = FALSE AND status != 'protected'`;
    }

    const result = await this.driver.query<BranchRow>(sql);
    const deleted: string[] = [];
    const skipped: string[] = [];

    for (const row of result.rows) {
      const branch = this.mapBranchRow(row);
      if (options.dryRun) {
        deleted.push(branch.slug);
      } else {
        try {
          await this.deleteBranch(branch.slug, true);
          deleted.push(branch.slug);
        } catch (error) {
          skipped.push(`${branch.slug}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    return { deleted, skipped };
  }

  async protectBranch(branchSlug: string): Promise<void> {
    const branch = await this.getBranchBySlug(branchSlug);
    if (!branch) {
      throw new Error(`Branch '${branchSlug}' not found`);
    }

    await this.driver.execute(
      `
      UPDATE ${this.quoteIdent(this.metadataTable)}
      SET is_protected = TRUE, status = 'protected'
      WHERE id = $1
    `,
      [branch.id]
    );
  }

  async unprotectBranch(branchSlug: string): Promise<void> {
    const branch = await this.getBranchBySlug(branchSlug);
    if (!branch) {
      throw new Error(`Branch '${branchSlug}' not found`);
    }

    await this.driver.execute(
      `
      UPDATE ${this.quoteIdent(this.metadataTable)}
      SET is_protected = FALSE, status = 'active'
      WHERE id = $1
    `,
      [branch.id]
    );
  }

  async updateBranchStats(branchSlug: string): Promise<void> {
    const branch = await this.getBranchBySlug(branchSlug);
    if (!branch) {
      throw new Error(`Branch '${branchSlug}' not found`);
    }

    const tableCount = await this.getTableCount(this.driver, branch.schemaName);

    const storageResult = await this.driver.query<{ storage_bytes: string }>(
      `
      SELECT COALESCE(sum(pg_total_relation_size(quote_ident(schemaname) || '.' || quote_ident(tablename)))::bigint, 0)::text as storage_bytes
      FROM pg_tables
      WHERE schemaname = $1
    `,
      [branch.schemaName]
    );

    const storageBytes = Number.parseInt(storageResult.rows[0]?.storage_bytes ?? '0', 10);

    await this.driver.execute(
      `
      UPDATE ${this.quoteIdent(this.metadataTable)}
      SET table_count = $1, storage_bytes = $2
      WHERE id = $3
    `,
      [tableCount, storageBytes, branch.id]
    );
  }

  private async cloneSchemaStructure(
    trx: TransactionClient,
    sourceSchema: string,
    targetSchema: string
  ): Promise<void> {
    const tablesResult = await trx.query<{ tablename: string }>(
      `
      SELECT tablename FROM pg_tables
      WHERE schemaname = $1 AND tablename NOT LIKE 'lp_%'
    `,
      [sourceSchema]
    );

    for (const { tablename } of tablesResult.rows) {
      await trx.execute(`
        CREATE TABLE ${this.quoteIdent(targetSchema)}.${this.quoteIdent(tablename)}
        (LIKE ${this.quoteIdent(sourceSchema)}.${this.quoteIdent(tablename)}
         INCLUDING ALL)
      `);
    }

    await this.cloneSequences(trx, sourceSchema, targetSchema);
    await this.cloneViews(trx, sourceSchema, targetSchema);
  }

  private async cloneSequences(
    trx: TransactionClient,
    sourceSchema: string,
    targetSchema: string
  ): Promise<void> {
    const sequencesResult = await trx.query<{ sequence_name: string }>(
      `
      SELECT sequence_name
      FROM information_schema.sequences
      WHERE sequence_schema = $1
    `,
      [sourceSchema]
    );

    for (const { sequence_name } of sequencesResult.rows) {
      const seqInfo = await trx.query<{
        start_value: string;
        increment_by: string;
        min_value: string;
        max_value: string;
        last_value: string | null;
      }>(
        `
        SELECT start_value::text, increment_by::text, min_value::text, max_value::text, last_value::text
        FROM pg_sequences
        WHERE schemaname = $1 AND sequencename = $2
      `,
        [sourceSchema, sequence_name]
      );

      if (seqInfo.rows.length > 0) {
        const seq = seqInfo.rows[0];
        await trx.execute(`
          CREATE SEQUENCE IF NOT EXISTS ${this.quoteIdent(targetSchema)}.${this.quoteIdent(sequence_name)}
          START WITH ${seq.last_value ?? seq.start_value}
          INCREMENT BY ${seq.increment_by}
          MINVALUE ${seq.min_value}
          MAXVALUE ${seq.max_value}
        `);
      }
    }
  }

  private async cloneViews(
    trx: TransactionClient,
    sourceSchema: string,
    targetSchema: string
  ): Promise<void> {
    const viewsResult = await trx.query<{ viewname: string; definition: string }>(
      `
      SELECT viewname, definition
      FROM pg_views
      WHERE schemaname = $1
    `,
      [sourceSchema]
    );

    for (const { viewname, definition } of viewsResult.rows) {
      const adjustedDefinition = definition.replace(
        new RegExp(`${sourceSchema}\\.`, 'g'),
        `${targetSchema}.`
      );

      await trx.execute(`
        CREATE OR REPLACE VIEW ${this.quoteIdent(targetSchema)}.${this.quoteIdent(viewname)} AS
        ${adjustedDefinition}
      `);
    }
  }

  private async copyDataWithMasking(
    trx: TransactionClient,
    sourceSchema: string,
    targetSchema: string,
    applyMasking: boolean
  ): Promise<void> {
    const tablesResult = await trx.query<{ tablename: string }>(
      `
      SELECT tablename FROM pg_tables
      WHERE schemaname = $1 AND tablename NOT LIKE 'lp_%'
    `,
      [sourceSchema]
    );

    for (const { tablename } of tablesResult.rows) {
      if (applyMasking) {
        const columnsResult = await trx.query<{ column_name: string; data_type: string }>(
          `
          SELECT column_name, data_type
          FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2
          ORDER BY ordinal_position
        `,
          [sourceSchema, tablename]
        );

        const columnList = columnsResult.rows
          .map((col) => this.quoteIdent(col.column_name))
          .join(', ');
        const selectList = columnsResult.rows
          .map((col) => {
            const isPii = this.isPiiColumn(col.column_name);
            if ((isPii && col.data_type === 'character varying') || col.data_type === 'text') {
              if (col.column_name.toLowerCase().includes('email')) {
                return `CASE WHEN ${this.quoteIdent(col.column_name)} IS NOT NULL
                THEN 'masked_' || substr(md5(${this.quoteIdent(col.column_name)}::text), 1, 8) || '@example.com'
                ELSE NULL END AS ${this.quoteIdent(col.column_name)}`;
              }
              return `CASE WHEN ${this.quoteIdent(col.column_name)} IS NOT NULL
              THEN 'masked_' || substr(md5(${this.quoteIdent(col.column_name)}::text), 1, 8)
              ELSE NULL END AS ${this.quoteIdent(col.column_name)}`;
            }
            return this.quoteIdent(col.column_name);
          })
          .join(', ');

        await trx.execute(`
          INSERT INTO ${this.quoteIdent(targetSchema)}.${this.quoteIdent(tablename)} (${columnList})
          SELECT ${selectList}
          FROM ${this.quoteIdent(sourceSchema)}.${this.quoteIdent(tablename)}
        `);
      } else {
        await trx.execute(`
          INSERT INTO ${this.quoteIdent(targetSchema)}.${this.quoteIdent(tablename)}
          SELECT * FROM ${this.quoteIdent(sourceSchema)}.${this.quoteIdent(tablename)}
        `);
      }
    }
  }

  private isPiiColumn(columnName: string): boolean {
    const piiPatterns = [
      'email',
      'phone',
      'address',
      'ssn',
      'social_security',
      'credit_card',
      'password',
      'secret',
      'token',
      'first_name',
      'last_name',
      'full_name',
      'name',
      'dob',
      'date_of_birth',
      'ip_address',
      'ip',
      'location',
      'latitude',
      'longitude',
    ];

    const lower = columnName.toLowerCase();
    return piiPatterns.some((pattern) => lower.includes(pattern));
  }

  private async getTableCount(
    client: Driver | TransactionClient,
    schemaName: string
  ): Promise<number> {
    const result = await client.query<{ count: string }>(
      `
      SELECT COUNT(*)::text as count
      FROM pg_tables
      WHERE schemaname = $1 AND tablename NOT LIKE 'lp_%'
    `,
      [schemaName]
    );

    return Number.parseInt(result.rows[0]?.count ?? '0', 10);
  }

  private generateSlug(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .substring(0, 100);
  }

  private quoteIdent(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  private async resolveSchemaName(branchName: string): Promise<string> {
    if (branchName === 'main' || branchName === 'public') {
      return this.mainSchema;
    }
    const branch = await this.getBranchBySlug(branchName);
    if (!branch) {
      throw new Error(`Branch '${branchName}' not found`);
    }
    return branch.schemaName;
  }

  private generateConnectionString(branch: Branch): string {
    const baseUrl = process.env.DATABASE_URL || '';
    if (!baseUrl) {
      return `options=-c search_path=${branch.schemaName},public`;
    }
    try {
      const url = new URL(baseUrl);
      url.searchParams.set('options', `-c search_path=${branch.schemaName},public`);
      return url.toString();
    } catch {
      return `${baseUrl}?options=-c search_path=${branch.schemaName},public`;
    }
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
      status: row.status as BranchStatus,
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

export function createBranchManager(options: BranchManagerOptions): BranchManager {
  return new BranchManager(options);
}
