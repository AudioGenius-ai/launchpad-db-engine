import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Dialect } from '../migrations/dialects/types.js';
import type { SchemaDefinition } from '../types/index.js';
import { SchemaDiffEngine } from './diff.js';

const createMockDialect = (): Dialect => ({
  name: 'postgresql',
  supportsTransactionalDDL: true,
  mapType: vi.fn((type) => type.toUpperCase()),
  createTable: vi.fn((name) => `CREATE TABLE "${name}" (...)`),
  dropTable: vi.fn((name) => `DROP TABLE IF EXISTS "${name}" CASCADE`),
  addColumn: vi.fn((table, col) => `ALTER TABLE "${table}" ADD COLUMN "${col}" ...`),
  dropColumn: vi.fn((table, col) => `ALTER TABLE "${table}" DROP COLUMN "${col}"`),
  alterColumn: vi.fn((table, col) => `ALTER TABLE "${table}" ALTER COLUMN "${col}" ...`),
  createIndex: vi.fn((table, idx) => `CREATE INDEX ON "${table}" (...)`),
  dropIndex: vi.fn((name) => `DROP INDEX IF EXISTS "${name}"`),
  addForeignKey: vi.fn(() => 'ALTER TABLE ... ADD CONSTRAINT ...'),
  dropForeignKey: vi.fn(() => 'ALTER TABLE ... DROP CONSTRAINT ...'),
  introspectTablesQuery: vi.fn(),
  introspectColumnsQuery: vi.fn(),
  introspectIndexesQuery: vi.fn(),
});

describe('SchemaDiffEngine', () => {
  let dialect: Dialect;
  let diffEngine: SchemaDiffEngine;

  beforeEach(() => {
    dialect = createMockDialect();
    diffEngine = new SchemaDiffEngine(dialect);
  });

  describe('computeDiff', () => {
    it('should detect no differences when schemas are identical', () => {
      const schema: SchemaDefinition = {
        tables: {
          users: {
            columns: {
              id: { type: 'uuid', primaryKey: true },
              name: { type: 'string', nullable: false },
            },
          },
        },
      };

      const diff = diffEngine.computeDiff(schema, schema);

      expect(diff.hasDifferences).toBe(false);
      expect(diff.changes).toHaveLength(0);
      expect(diff.breakingChanges).toHaveLength(0);
    });

    it('should detect table addition', () => {
      const current: SchemaDefinition = { tables: {} };
      const target: SchemaDefinition = {
        tables: {
          users: {
            columns: {
              id: { type: 'uuid', primaryKey: true },
            },
          },
        },
      };

      const diff = diffEngine.computeDiff(current, target);

      expect(diff.hasDifferences).toBe(true);
      expect(diff.summary.tablesAdded).toBe(1);
      expect(diff.changes.some((c) => c.type === 'table_add' && c.tableName === 'users')).toBe(
        true
      );
    });

    it('should detect table drop as breaking change', () => {
      const current: SchemaDefinition = {
        tables: {
          users: {
            columns: {
              id: { type: 'uuid', primaryKey: true },
            },
          },
        },
      };
      const target: SchemaDefinition = { tables: {} };

      const diff = diffEngine.computeDiff(current, target);

      expect(diff.hasDifferences).toBe(true);
      expect(diff.summary.tablesDropped).toBe(1);
      expect(diff.breakingChanges).toHaveLength(1);
      expect(diff.breakingChanges[0].type).toBe('table_drop');
    });

    it('should detect column addition', () => {
      const current: SchemaDefinition = {
        tables: {
          users: {
            columns: {
              id: { type: 'uuid', primaryKey: true },
            },
          },
        },
      };
      const target: SchemaDefinition = {
        tables: {
          users: {
            columns: {
              id: { type: 'uuid', primaryKey: true },
              email: { type: 'string', nullable: false },
            },
          },
        },
      };

      const diff = diffEngine.computeDiff(current, target);

      expect(diff.hasDifferences).toBe(true);
      expect(diff.summary.columnsAdded).toBe(1);
      expect(diff.changes.some((c) => c.type === 'column_add' && c.objectName === 'email')).toBe(
        true
      );
    });

    it('should detect column drop as breaking change', () => {
      const current: SchemaDefinition = {
        tables: {
          users: {
            columns: {
              id: { type: 'uuid', primaryKey: true },
              email: { type: 'string', nullable: false },
            },
          },
        },
      };
      const target: SchemaDefinition = {
        tables: {
          users: {
            columns: {
              id: { type: 'uuid', primaryKey: true },
            },
          },
        },
      };

      const diff = diffEngine.computeDiff(current, target);

      expect(diff.hasDifferences).toBe(true);
      expect(diff.summary.columnsDropped).toBe(1);
      expect(diff.breakingChanges.some((c) => c.type === 'column_drop')).toBe(true);
    });

    it('should detect column modification', () => {
      const current: SchemaDefinition = {
        tables: {
          users: {
            columns: {
              id: { type: 'uuid', primaryKey: true },
              name: { type: 'string', nullable: true },
            },
          },
        },
      };
      const target: SchemaDefinition = {
        tables: {
          users: {
            columns: {
              id: { type: 'uuid', primaryKey: true },
              name: { type: 'text', nullable: true },
            },
          },
        },
      };

      const diff = diffEngine.computeDiff(current, target);

      expect(diff.hasDifferences).toBe(true);
      expect(diff.summary.columnsModified).toBe(1);
    });

    it('should detect index addition', () => {
      const current: SchemaDefinition = {
        tables: {
          users: {
            columns: {
              id: { type: 'uuid', primaryKey: true },
              email: { type: 'string' },
            },
          },
        },
      };
      const target: SchemaDefinition = {
        tables: {
          users: {
            columns: {
              id: { type: 'uuid', primaryKey: true },
              email: { type: 'string' },
            },
            indexes: [{ name: 'idx_users_email', columns: ['email'], unique: true }],
          },
        },
      };

      const diff = diffEngine.computeDiff(current, target);

      expect(diff.hasDifferences).toBe(true);
      expect(diff.summary.indexesAdded).toBe(1);
    });

    it('should mark nullable change to non-nullable as breaking', () => {
      const current: SchemaDefinition = {
        tables: {
          users: {
            columns: {
              id: { type: 'uuid', primaryKey: true },
              name: { type: 'string', nullable: true },
            },
          },
        },
      };
      const target: SchemaDefinition = {
        tables: {
          users: {
            columns: {
              id: { type: 'uuid', primaryKey: true },
              name: { type: 'string', nullable: false },
            },
          },
        },
      };

      const diff = diffEngine.computeDiff(current, target);

      expect(diff.hasDifferences).toBe(true);
      expect(diff.breakingChanges.length).toBeGreaterThan(0);
    });
  });

  describe('generateMigration', () => {
    it('should generate migration script with up and down SQL', () => {
      const current: SchemaDefinition = { tables: {} };
      const target: SchemaDefinition = {
        tables: {
          users: {
            columns: {
              id: { type: 'uuid', primaryKey: true },
            },
          },
        },
      };

      const diff = diffEngine.computeDiff(current, target, { generateMigration: true });

      expect(diff.migration).not.toBeNull();
      expect(diff.migration?.upSql).toHaveLength(1);
      expect(diff.migration?.downSql).toHaveLength(1);
      expect(diff.migration?.checksum).toBeTruthy();
    });

    it('should not generate migration when no changes', () => {
      const schema: SchemaDefinition = {
        tables: {
          users: {
            columns: {
              id: { type: 'uuid', primaryKey: true },
            },
          },
        },
      };

      const diff = diffEngine.computeDiff(schema, schema);

      expect(diff.migration).toBeNull();
    });
  });

  describe('formatDiff', () => {
    it('should format diff as text', () => {
      const current: SchemaDefinition = { tables: {} };
      const target: SchemaDefinition = {
        tables: {
          users: {
            columns: {
              id: { type: 'uuid', primaryKey: true },
            },
          },
        },
      };

      const diff = diffEngine.computeDiff(current, target);
      const output = diffEngine.formatDiff(diff, 'text');

      expect(output).toContain('Schema Diff');
      expect(output).toContain('table');
      expect(output).toContain('added');
    });

    it('should format diff as JSON', () => {
      const current: SchemaDefinition = { tables: {} };
      const target: SchemaDefinition = {
        tables: {
          users: {
            columns: {
              id: { type: 'uuid', primaryKey: true },
            },
          },
        },
      };

      const diff = diffEngine.computeDiff(current, target);
      const output = diffEngine.formatDiff(diff, 'json');

      const parsed = JSON.parse(output);
      expect(parsed.hasDifferences).toBe(true);
      expect(parsed.changes).toBeInstanceOf(Array);
    });

    it('should format diff as SQL', () => {
      const current: SchemaDefinition = { tables: {} };
      const target: SchemaDefinition = {
        tables: {
          users: {
            columns: {
              id: { type: 'uuid', primaryKey: true },
            },
          },
        },
      };

      const diff = diffEngine.computeDiff(current, target);
      const output = diffEngine.formatDiff(diff, 'sql');

      expect(output).toContain('-- Up');
      expect(output).toContain('-- Down');
      expect(output).toContain('CREATE TABLE');
    });

    it('should show no changes message when identical', () => {
      const schema: SchemaDefinition = {
        tables: {
          users: {
            columns: {
              id: { type: 'uuid', primaryKey: true },
            },
          },
        },
      };

      const diff = diffEngine.computeDiff(schema, schema);
      const output = diffEngine.formatDiff(diff, 'text');

      expect(output).toContain('No differences');
    });
  });

  describe('summary', () => {
    it('should correctly summarize changes', () => {
      const current: SchemaDefinition = {
        tables: {
          old_table: {
            columns: {
              id: { type: 'uuid', primaryKey: true },
            },
          },
          users: {
            columns: {
              id: { type: 'uuid', primaryKey: true },
              old_col: { type: 'string' },
            },
          },
        },
      };
      const target: SchemaDefinition = {
        tables: {
          users: {
            columns: {
              id: { type: 'uuid', primaryKey: true },
              new_col: { type: 'string' },
            },
            indexes: [{ name: 'idx_new', columns: ['new_col'] }],
          },
          new_table: {
            columns: {
              id: { type: 'uuid', primaryKey: true },
            },
          },
        },
      };

      const diff = diffEngine.computeDiff(current, target);

      expect(diff.summary.tablesAdded).toBe(1);
      expect(diff.summary.tablesDropped).toBe(1);
      expect(diff.summary.columnsAdded).toBe(1);
      expect(diff.summary.columnsDropped).toBe(1);
      expect(diff.summary.indexesAdded).toBe(1);
    });
  });
});
