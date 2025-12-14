import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { MigrationFile } from '../types/index.js';
import type { ModuleMigrationSource } from './types.js';

export interface MigrationCollectorOptions {
  scope?: 'core' | 'template';
}

export class MigrationCollector {
  async discoverFromDirectory(basePath: string): Promise<ModuleMigrationSource[]> {
    const sources: ModuleMigrationSource[] = [];

    try {
      const entries = await readdir(basePath);

      for (const entry of entries) {
        const entryPath = join(basePath, entry);
        const entryStat = await stat(entryPath);

        if (entryStat.isDirectory()) {
          sources.push({
            moduleName: entry,
            migrationsPath: entryPath,
          });
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    return sources.sort((a, b) => a.moduleName.localeCompare(b.moduleName));
  }

  async collect(
    sources: ModuleMigrationSource[],
    options: MigrationCollectorOptions = {}
  ): Promise<MigrationFile[]> {
    const migrations: MigrationFile[] = [];

    for (const source of sources) {
      const sourceMigrations = await this.loadMigrationsFromSource(source, options);
      migrations.push(...sourceMigrations);
    }

    return this.orderMigrations(migrations);
  }

  private async loadMigrationsFromSource(
    source: ModuleMigrationSource,
    options: MigrationCollectorOptions = {}
  ): Promise<MigrationFile[]> {
    const scope = options.scope ?? 'core';
    const migrations: MigrationFile[] = [];

    try {
      const files = await readdir(source.migrationsPath);
      const sqlFiles = files.filter((f) => f.endsWith('.sql')).sort();

      for (const file of sqlFiles) {
        const content = await readFile(join(source.migrationsPath, file), 'utf-8');
        const parsed = this.parseMigrationFile(file, content, scope, source.moduleName);
        if (parsed) {
          migrations.push(parsed);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    return migrations;
  }

  private parseMigrationFile(
    filename: string,
    content: string,
    scope: 'core' | 'template',
    moduleName: string
  ): MigrationFile | null {
    const match = filename.match(/^(\d+)__(.+)\.sql$/);
    if (!match) return null;

    const [, versionStr, name] = match;
    const version = Number.parseInt(versionStr, 10);

    const upMatch = content.match(/--\s*up\s*\n([\s\S]*?)(?=--\s*down|$)/i);
    const downMatch = content.match(/--\s*down\s*\n([\s\S]*?)$/i);

    const up = upMatch ? this.splitSqlStatements(upMatch[1]) : [];
    const down = downMatch ? this.splitSqlStatements(downMatch[1]) : [];

    if (!up.length) return null;

    return {
      version,
      name,
      up,
      down,
      scope,
      moduleName,
    };
  }

  private orderMigrations(migrations: MigrationFile[]): MigrationFile[] {
    return migrations.sort((a, b) => {
      if (a.version !== b.version) {
        return a.version - b.version;
      }
      const moduleA = a.moduleName ?? '';
      const moduleB = b.moduleName ?? '';
      return moduleA.localeCompare(moduleB);
    });
  }

  private splitSqlStatements(sql: string): string[] {
    const statements: string[] = [];
    let current = '';
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inDollarQuote = false;
    let dollarTag = '';
    let inLineComment = false;
    let inBlockComment = false;

    for (let i = 0; i < sql.length; i++) {
      const char = sql[i];
      const next = sql[i + 1] || '';

      if (inLineComment) {
        current += char;
        if (char === '\n') {
          inLineComment = false;
        }
        continue;
      }

      if (inBlockComment) {
        current += char;
        if (char === '*' && next === '/') {
          current += next;
          i++;
          inBlockComment = false;
        }
        continue;
      }

      if (inDollarQuote) {
        current += char;
        if (char === '$') {
          const endTag = sql.slice(i).match(/^\$[a-zA-Z0-9_]*\$/);
          if (endTag && endTag[0] === dollarTag) {
            current += sql.slice(i + 1, i + dollarTag.length);
            i += dollarTag.length - 1;
            inDollarQuote = false;
            dollarTag = '';
          }
        }
        continue;
      }

      if (inSingleQuote) {
        current += char;
        if (char === "'" && next !== "'") {
          inSingleQuote = false;
        } else if (char === "'" && next === "'") {
          current += next;
          i++;
        }
        continue;
      }

      if (inDoubleQuote) {
        current += char;
        if (char === '"' && next !== '"') {
          inDoubleQuote = false;
        } else if (char === '"' && next === '"') {
          current += next;
          i++;
        }
        continue;
      }

      if (char === '-' && next === '-') {
        inLineComment = true;
        current += char;
        continue;
      }

      if (char === '/' && next === '*') {
        inBlockComment = true;
        current += char;
        continue;
      }

      if (char === '$') {
        const tag = sql.slice(i).match(/^\$[a-zA-Z0-9_]*\$/);
        if (tag) {
          inDollarQuote = true;
          dollarTag = tag[0];
          current += dollarTag;
          i += dollarTag.length - 1;
          continue;
        }
      }

      if (char === "'") {
        inSingleQuote = true;
        current += char;
        continue;
      }

      if (char === '"') {
        inDoubleQuote = true;
        current += char;
        continue;
      }

      if (char === ';') {
        const trimmed = current.trim();
        if (trimmed) {
          statements.push(trimmed);
        }
        current = '';
        continue;
      }

      current += char;
    }

    const trimmed = current.trim();
    if (trimmed) {
      statements.push(trimmed);
    }

    return statements;
  }
}

export function createMigrationCollector(): MigrationCollector {
  return new MigrationCollector();
}
