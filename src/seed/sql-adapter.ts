import type { Driver } from '../driver/types.js';
import { type SeedResult, Seeder, type SeederLogger } from './base.js';

export class SqlSeederAdapter extends Seeder {
  private sqlContent: string;
  private seederName: string;

  constructor(driver: Driver, sqlContent: string, name: string, logger?: SeederLogger) {
    super(driver, logger);
    this.sqlContent = sqlContent;
    this.seederName = name;
  }

  get name(): string {
    return this.seederName;
  }

  async run(): Promise<SeedResult> {
    const statements = this.splitStatements(this.sqlContent);
    let totalCount = 0;

    for (const sql of statements) {
      if (sql.trim()) {
        const result = await this.execute(sql);
        totalCount += result.rowCount;
      }
    }

    return { count: totalCount };
  }

  private splitStatements(sql: string): string[] {
    const statements: string[] = [];
    let current = '';
    let inQuote = false;
    let quoteChar = '';
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

      if (inQuote) {
        current += char;
        if (char === quoteChar && next !== quoteChar) {
          inQuote = false;
        } else if (char === quoteChar && next === quoteChar) {
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

      if (char === "'" || char === '"') {
        inQuote = true;
        quoteChar = char;
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
