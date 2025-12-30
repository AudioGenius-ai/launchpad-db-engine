import type { Driver, TransactionClient } from '../driver/types.js';

export interface ConnectionManagerOptions {
  driver: Driver;
  mainSchema?: string;
  branchPrefix?: string;
}

export interface BranchConnection {
  schemaName: string;
  searchPath: string;
  connectionString: string;
}

export class ConnectionManager {
  private driver: Driver;
  private mainSchema: string;
  private branchPrefix: string;
  private currentSchema: string;

  constructor(options: ConnectionManagerOptions) {
    this.driver = options.driver;
    this.mainSchema = options.mainSchema ?? 'public';
    this.branchPrefix = options.branchPrefix ?? 'branch_';
    this.currentSchema = this.mainSchema;
  }

  async switchToBranch(branchSlug: string): Promise<BranchConnection> {
    const schemaName = await this.getSchemaForBranch(branchSlug);
    const searchPath = `${schemaName}, public`;

    await this.driver.execute(`SET search_path TO ${searchPath}`);

    this.currentSchema = schemaName;

    await this.updateLastAccessed(branchSlug);

    return {
      schemaName,
      searchPath,
      connectionString: this.generateConnectionString(schemaName),
    };
  }

  async switchToMain(): Promise<BranchConnection> {
    const searchPath = `${this.mainSchema}, public`;

    await this.driver.execute(`SET search_path TO ${searchPath}`);

    this.currentSchema = this.mainSchema;

    return {
      schemaName: this.mainSchema,
      searchPath,
      connectionString: this.generateConnectionString(this.mainSchema),
    };
  }

  async withBranch<T>(
    branchSlug: string,
    callback: (client: TransactionClient) => Promise<T>
  ): Promise<T> {
    const schemaName = await this.getSchemaForBranch(branchSlug);
    const searchPath = `${schemaName}, public`;

    return await this.driver.transaction(async (trx) => {
      await trx.execute(`SET LOCAL search_path TO ${searchPath}`);
      return callback(trx);
    });
  }

  async withSchema<T>(
    schemaName: string,
    callback: (client: TransactionClient) => Promise<T>
  ): Promise<T> {
    const searchPath = `${schemaName}, public`;

    return await this.driver.transaction(async (trx) => {
      await trx.execute(`SET LOCAL search_path TO ${searchPath}`);
      return callback(trx);
    });
  }

  getCurrentSchema(): string {
    return this.currentSchema;
  }

  async getCurrentSearchPath(): Promise<string> {
    const result = await this.driver.query<{ search_path: string }>('SHOW search_path');
    return result.rows[0]?.search_path ?? this.mainSchema;
  }

  async validateSchema(schemaName: string): Promise<boolean> {
    const result = await this.driver.query<{ exists: boolean }>(
      `
      SELECT EXISTS (
        SELECT 1 FROM information_schema.schemata
        WHERE schema_name = $1
      ) as exists
    `,
      [schemaName]
    );

    return result.rows[0]?.exists ?? false;
  }

  async listAvailableSchemas(): Promise<string[]> {
    const result = await this.driver.query<{ schema_name: string }>(
      `
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name LIKE $1 OR schema_name = $2
      ORDER BY schema_name
    `,
      [`${this.branchPrefix}%`, this.mainSchema]
    );

    return result.rows.map((row) => row.schema_name);
  }

  generateConnectionString(schemaName: string): string {
    const baseUrl = process.env.DATABASE_URL || '';
    if (!baseUrl) {
      return `options=-c search_path=${schemaName},public`;
    }

    try {
      const url = new URL(baseUrl);
      url.searchParams.set('options', `-c search_path=${schemaName},public`);
      return url.toString();
    } catch {
      const separator = baseUrl.includes('?') ? '&' : '?';
      return `${baseUrl}${separator}options=-c search_path=${schemaName},public`;
    }
  }

  generateEnvVars(schemaName: string): Record<string, string> {
    return {
      DATABASE_URL: this.generateConnectionString(schemaName),
      DB_SCHEMA: schemaName,
      DB_SEARCH_PATH: `${schemaName}, public`,
    };
  }

  private async getSchemaForBranch(branchSlug: string): Promise<string> {
    if (branchSlug === 'main' || branchSlug === 'public') {
      return this.mainSchema;
    }

    const result = await this.driver.query<{ schema_name: string }>(
      `
      SELECT schema_name FROM lp_branch_metadata
      WHERE slug = $1 AND deleted_at IS NULL
    `,
      [branchSlug]
    );

    if (result.rows.length === 0) {
      throw new Error(`Branch '${branchSlug}' not found`);
    }

    return result.rows[0].schema_name;
  }

  private async updateLastAccessed(branchSlug: string): Promise<void> {
    await this.driver.execute(
      `
      UPDATE lp_branch_metadata
      SET last_accessed_at = NOW()
      WHERE slug = $1
    `,
      [branchSlug]
    );
  }
}

export function createConnectionManager(options: ConnectionManagerOptions): ConnectionManager {
  return new ConnectionManager(options);
}
