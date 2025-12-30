import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Driver } from '../driver/types.js';
import type { Seeder, SeederLogger } from './base.js';
import { SqlSeederAdapter } from './sql-adapter.js';

export type SeederConstructor = new (driver: Driver, logger?: SeederLogger) => Seeder;

export interface LoadedSeeder {
  name: string;
  path: string;
  type: 'typescript' | 'sql';
  order: number;
  dependencies: string[];
  SeederClass?: SeederConstructor & { order?: number; dependencies?: string[]; version?: number };
  sqlContent?: string;
}

export interface SeedLoaderOptions {
  seedsPath?: string;
}

export class SeedLoader {
  private seedsPath: string;

  constructor(options: SeedLoaderOptions = {}) {
    this.seedsPath = options.seedsPath ?? './seeds';
  }

  async discover(): Promise<LoadedSeeder[]> {
    const files = await this.findSeedFiles();
    const seeders: LoadedSeeder[] = [];

    for (const file of files) {
      if (file.endsWith('.ts') || file.endsWith('.js')) {
        seeders.push(await this.loadTypeScriptSeeder(file));
      } else if (file.endsWith('.sql')) {
        seeders.push(await this.loadSqlSeeder(file));
      }
    }

    return this.sortByDependencies(seeders);
  }

  private async findSeedFiles(): Promise<string[]> {
    try {
      const files = await readdir(this.seedsPath);
      return files
        .filter((f) => f.endsWith('.ts') || f.endsWith('.js') || f.endsWith('.sql'))
        .filter((f) => !f.endsWith('.test.ts') && !f.endsWith('.spec.ts'))
        .filter((f) => f !== 'index.ts' && f !== 'index.js')
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  private async loadTypeScriptSeeder(filename: string): Promise<LoadedSeeder> {
    const fullPath = join(this.seedsPath, filename);
    const fileUrl = pathToFileURL(fullPath).href;
    const module = await import(fileUrl);
    const SeederClass = module.default as SeederConstructor & {
      order?: number;
      dependencies?: string[];
      version?: number;
    };

    if (!SeederClass || typeof SeederClass !== 'function') {
      throw new Error(`Seeder file ${filename} must export a default class extending Seeder`);
    }

    const name = this.extractName(filename);
    const order = SeederClass.order ?? this.extractOrderFromFilename(filename);
    const dependencies = SeederClass.dependencies ?? [];

    return {
      name,
      path: fullPath,
      type: 'typescript',
      order,
      dependencies,
      SeederClass,
    };
  }

  private async loadSqlSeeder(filename: string): Promise<LoadedSeeder> {
    const fullPath = join(this.seedsPath, filename);
    const sqlContent = await readFile(fullPath, 'utf-8');

    const name = this.extractName(filename);
    const order = this.extractOrderFromFilename(filename);

    return {
      name,
      path: fullPath,
      type: 'sql',
      order,
      dependencies: [],
      sqlContent,
    };
  }

  private extractName(filename: string): string {
    const base = basename(filename).replace(/\.(ts|js|sql)$/, '');
    return base.replace(/^\d+[-_]/, '');
  }

  private extractOrderFromFilename(filename: string): number {
    const match = filename.match(/^(\d+)[-_]/);
    return match ? Number.parseInt(match[1], 10) : 999;
  }

  private sortByDependencies(seeders: LoadedSeeder[]): LoadedSeeder[] {
    return this.topologicalSort(seeders);
  }

  private topologicalSort(seeders: LoadedSeeder[]): LoadedSeeder[] {
    const seederMap = new Map(seeders.map((s) => [s.name, s]));
    const inDegree = new Map<string, number>();
    const graph = new Map<string, string[]>();

    for (const seeder of seeders) {
      inDegree.set(seeder.name, seeder.dependencies.length);
      graph.set(seeder.name, []);
    }

    for (const seeder of seeders) {
      for (const dep of seeder.dependencies) {
        if (!seederMap.has(dep)) {
          throw new Error(`Seeder "${seeder.name}" depends on unknown seeder "${dep}"`);
        }
        graph.get(dep)!.push(seeder.name);
      }
    }

    const queue = seeders.filter((s) => inDegree.get(s.name) === 0);
    queue.sort((a, b) => a.order - b.order);
    const result: LoadedSeeder[] = [];

    while (queue.length > 0) {
      queue.sort((a, b) => a.order - b.order);
      const current = queue.shift()!;
      result.push(current);

      for (const dependent of graph.get(current.name)!) {
        const newDegree = inDegree.get(dependent)! - 1;
        inDegree.set(dependent, newDegree);
        if (newDegree === 0) {
          queue.push(seederMap.get(dependent)!);
        }
      }
    }

    if (result.length !== seeders.length) {
      const remaining = seeders.filter((s) => !result.includes(s)).map((s) => s.name);
      throw new Error(`Circular dependency detected in seeders: ${remaining.join(', ')}`);
    }

    return result;
  }

  createInstance(loaded: LoadedSeeder, driver: Driver, logger?: SeederLogger): Seeder {
    if (loaded.type === 'typescript' && loaded.SeederClass) {
      return new loaded.SeederClass(driver, logger);
    }
    if (loaded.type === 'sql' && loaded.sqlContent) {
      return new SqlSeederAdapter(driver, loaded.sqlContent, loaded.name, logger);
    }
    throw new Error(`Cannot create instance for seeder: ${loaded.name}`);
  }
}
