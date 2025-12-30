import type { Driver } from '../driver/types.js';
import { getDialect } from '../migrations/dialects/index.js';
import type { Dialect } from '../migrations/dialects/types.js';
import type { SeedResult, Seeder, SeederLogger } from './base.js';
import { type LoadedSeeder, SeedLoader } from './loader.js';
import { SeedTracker } from './tracker.js';

export interface SeedRunnerOptions {
  seedsPath?: string;
  tableName?: string;
}

export interface SeedRunOptions {
  only?: string;
  fresh?: boolean;
  dryRun?: boolean;
  force?: boolean;
  allowProduction?: boolean;
}

export interface SeederResult {
  name: string;
  status: 'success' | 'skipped' | 'failed';
  count: number;
  duration: number;
  error?: string;
}

export interface SeedRunResult {
  success: boolean;
  seeders: SeederResult[];
  totalCount: number;
  totalDuration: number;
}

const defaultLogger: SeederLogger = {
  info: (msg) => console.log(msg),
  warn: (msg) => console.warn(msg),
  error: (msg) => console.error(msg),
};

export class SeedRunner {
  private driver: Driver;
  private dialect: Dialect;
  private loader: SeedLoader;
  private tracker: SeedTracker;
  private logger: SeederLogger;

  constructor(driver: Driver, options: SeedRunnerOptions = {}) {
    this.driver = driver;
    this.dialect = getDialect(driver.dialect);
    this.loader = new SeedLoader({ seedsPath: options.seedsPath });
    this.tracker = new SeedTracker(driver, { tableName: options.tableName });
    this.logger = defaultLogger;
  }

  async run(options: SeedRunOptions = {}): Promise<SeedRunResult> {
    if (process.env.NODE_ENV === 'production' && !options.allowProduction) {
      throw new Error(
        'Seeding in production is disabled by default. ' +
          'Use --allow-production flag to override (dangerous!).'
      );
    }

    await this.tracker.ensureTable();

    const allSeeders = await this.loader.discover();
    const filtered = this.filterSeeders(allSeeders, options);

    if (filtered.length === 0) {
      return { success: true, seeders: [], totalCount: 0, totalDuration: 0 };
    }

    if (options.fresh) {
      await this.truncateTables(filtered);
    }

    const result: SeedRunResult = {
      success: true,
      seeders: [],
      totalCount: 0,
      totalDuration: 0,
    };

    const startTime = Date.now();

    for (const loaded of filtered) {
      const seederResult = await this.executeSeeder(loaded, options);
      result.seeders.push(seederResult);
      result.totalCount += seederResult.count;

      if (seederResult.status === 'failed') {
        result.success = false;
        break;
      }
    }

    result.totalDuration = Date.now() - startTime;
    return result;
  }

  async rollback(seederName?: string): Promise<void> {
    const allSeeders = await this.loader.discover();
    const toRollback = seederName
      ? allSeeders.filter((s) => s.name === seederName)
      : allSeeders.reverse();

    for (const loaded of toRollback) {
      const instance = this.loader.createInstance(loaded, this.driver, this.logger);
      try {
        await instance.rollback();
        await this.tracker.remove(loaded.name);
        this.logger.info(`Rolled back: ${loaded.name}`);
      } catch {
        this.logger.warn(`Rollback not implemented for: ${loaded.name}`);
      }
    }
  }

  async status(): Promise<SeedRunResult> {
    await this.tracker.ensureTable();
    const records = await this.tracker.list();

    const seeders: SeederResult[] = records.map((r) => ({
      name: r.name,
      status: 'success' as const,
      count: r.record_count,
      duration: r.execution_time_ms,
    }));

    return {
      success: true,
      seeders,
      totalCount: seeders.reduce((sum, s) => sum + s.count, 0),
      totalDuration: seeders.reduce((sum, s) => sum + s.duration, 0),
    };
  }

  private filterSeeders(seeders: LoadedSeeder[], options: SeedRunOptions): LoadedSeeder[] {
    if (!options.only) return seeders;

    const target = seeders.find((s) => s.name.toLowerCase() === options.only!.toLowerCase());
    if (!target) {
      throw new Error(`Seeder not found: ${options.only}`);
    }

    const required = this.resolveDependencies(target, seeders);
    return required;
  }

  private resolveDependencies(target: LoadedSeeder, all: LoadedSeeder[]): LoadedSeeder[] {
    const result: LoadedSeeder[] = [];
    const visited = new Set<string>();

    const visit = (seeder: LoadedSeeder) => {
      if (visited.has(seeder.name)) return;
      visited.add(seeder.name);

      for (const depName of seeder.dependencies) {
        const dep = all.find((s) => s.name === depName);
        if (dep) visit(dep);
      }
      result.push(seeder);
    };

    visit(target);
    return result;
  }

  private async executeSeeder(
    loaded: LoadedSeeder,
    options: SeedRunOptions
  ): Promise<SeederResult> {
    const startTime = Date.now();

    if (!options.force) {
      const version = loaded.SeederClass?.version ?? 1;
      const hasRun = await this.tracker.hasRun(loaded.name, version);
      if (hasRun) {
        return {
          name: loaded.name,
          status: 'skipped',
          count: 0,
          duration: 0,
        };
      }
    }

    try {
      const instance = this.loader.createInstance(loaded, this.driver, this.logger);
      let seedResult: SeedResult;

      if (options.dryRun) {
        seedResult = await this.dryRunSeeder(instance);
      } else {
        seedResult = await this.runWithTransaction(instance);
        const version = loaded.SeederClass?.version ?? 1;
        await this.tracker.record(loaded.name, version, seedResult, Date.now() - startTime);
      }

      return {
        name: loaded.name,
        status: 'success',
        count: seedResult.count,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      return {
        name: loaded.name,
        status: 'failed',
        count: 0,
        duration: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async runWithTransaction(seeder: Seeder): Promise<SeedResult> {
    if (this.dialect.supportsTransactionalDDL) {
      return this.driver.transaction(async () => {
        return seeder.run();
      });
    }
    return seeder.run();
  }

  private async dryRunSeeder(seeder: Seeder): Promise<SeedResult> {
    await this.driver.execute('BEGIN');
    try {
      const result = await seeder.run();
      return result;
    } finally {
      await this.driver.execute('ROLLBACK');
    }
  }

  private async truncateTables(seeders: LoadedSeeder[]): Promise<void> {
    const tables = seeders.map((s) => s.name).reverse();
    for (const table of tables) {
      try {
        if (this.dialect.name === 'postgresql') {
          await this.driver.execute(`TRUNCATE TABLE "${table}" CASCADE`);
        } else if (this.dialect.name === 'mysql') {
          await this.driver.execute('SET FOREIGN_KEY_CHECKS = 0');
          await this.driver.execute(`TRUNCATE TABLE \`${table}\``);
          await this.driver.execute('SET FOREIGN_KEY_CHECKS = 1');
        } else {
          await this.driver.execute(`DELETE FROM "${table}"`);
        }
      } catch {
        // Table may not exist, continue
      }
    }
    await this.tracker.clear();
  }
}

export function createSeedRunner(driver: Driver, options?: SeedRunnerOptions): SeedRunner {
  return new SeedRunner(driver, options);
}
