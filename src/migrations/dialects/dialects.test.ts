import { describe, expect, it } from 'vitest';
import type { ColumnDefinition, ColumnType, TableDefinition } from '../../types/index.js';
import { mysqlDialect } from './mysql.js';
import { postgresDialect } from './postgresql.js';
import { sqliteDialect } from './sqlite.js';

describe('PostgreSQL Dialect', () => {
  describe('mapType', () => {
    it('should map all column types correctly', () => {
      const typeMap: Record<ColumnType, string> = {
        uuid: 'UUID',
        string: 'TEXT',
        text: 'TEXT',
        integer: 'INTEGER',
        bigint: 'BIGINT',
        float: 'DOUBLE PRECISION',
        decimal: 'NUMERIC',
        boolean: 'BOOLEAN',
        datetime: 'TIMESTAMPTZ',
        date: 'DATE',
        time: 'TIME',
        json: 'JSONB',
        binary: 'BYTEA',
      };

      for (const [type, expected] of Object.entries(typeMap)) {
        expect(postgresDialect.mapType(type as ColumnType)).toBe(expected);
      }
    });

    it('should return TEXT for unknown types', () => {
      expect(postgresDialect.mapType('unknown' as ColumnType)).toBe('TEXT');
    });
  });

  describe('createTable', () => {
    it('should create table with single primary key', () => {
      const def: TableDefinition = {
        columns: {
          id: { type: 'uuid', primaryKey: true },
          name: { type: 'string', nullable: false },
        },
      };

      const sql = postgresDialect.createTable('users', def);

      expect(sql).toContain('CREATE TABLE "users"');
      expect(sql).toContain('"id" UUID PRIMARY KEY');
      expect(sql).toContain('"name" TEXT NOT NULL');
    });

    it('should create table with composite primary key', () => {
      const def: TableDefinition = {
        columns: {
          user_id: { type: 'uuid' },
          org_id: { type: 'uuid' },
          role: { type: 'string' },
        },
        primaryKey: ['user_id', 'org_id'],
      };

      const sql = postgresDialect.createTable('user_orgs', def);

      expect(sql).toContain('PRIMARY KEY ("user_id", "org_id")');
      expect(sql).not.toContain('user_id" UUID PRIMARY KEY');
    });

    it('should handle nullable columns', () => {
      const def: TableDefinition = {
        columns: {
          id: { type: 'uuid', primaryKey: true },
          optional_field: { type: 'string', nullable: true },
        },
      };

      const sql = postgresDialect.createTable('test', def);

      expect(sql).toContain('"optional_field" TEXT');
      expect(sql).not.toContain('"optional_field" TEXT NOT NULL');
    });

    it('should add default values', () => {
      const def: TableDefinition = {
        columns: {
          id: { type: 'uuid', primaryKey: true, default: 'gen_random_uuid()' },
          created_at: { type: 'datetime', default: 'NOW()' },
          is_active: { type: 'boolean', default: 'true' },
        },
      };

      const sql = postgresDialect.createTable('accounts', def);

      expect(sql).toContain('DEFAULT gen_random_uuid()');
      expect(sql).toContain('DEFAULT NOW()');
      expect(sql).toContain('DEFAULT true');
    });

    it('should add unique constraints', () => {
      const def: TableDefinition = {
        columns: {
          id: { type: 'uuid', primaryKey: true },
          email: { type: 'string', unique: true, nullable: false },
        },
      };

      const sql = postgresDialect.createTable('users', def);

      expect(sql).toContain('"email" TEXT NOT NULL UNIQUE');
    });

    it('should add foreign key references', () => {
      const def: TableDefinition = {
        columns: {
          id: { type: 'uuid', primaryKey: true },
          user_id: {
            type: 'uuid',
            nullable: false,
            references: {
              table: 'users',
              column: 'id',
              onDelete: 'CASCADE',
            },
          },
        },
      };

      const sql = postgresDialect.createTable('posts', def);

      expect(sql).toContain('REFERENCES "users"("id")');
      expect(sql).toContain('ON DELETE CASCADE');
    });

    it('should handle foreign key with onUpdate', () => {
      const def: TableDefinition = {
        columns: {
          id: { type: 'uuid', primaryKey: true },
          parent_id: {
            type: 'uuid',
            references: {
              table: 'categories',
              column: 'id',
              onDelete: 'SET NULL',
              onUpdate: 'CASCADE',
            },
          },
        },
      };

      const sql = postgresDialect.createTable('categories', def);

      expect(sql).toContain('ON DELETE SET NULL');
      expect(sql).toContain('ON UPDATE CASCADE');
    });
  });

  describe('addColumn', () => {
    it('should add simple column', () => {
      const def: ColumnDefinition = { type: 'string', nullable: false };
      const sql = postgresDialect.addColumn('users', 'name', def);

      expect(sql).toBe('ALTER TABLE "users" ADD COLUMN "name" TEXT NOT NULL');
    });

    it('should add column with default', () => {
      const def: ColumnDefinition = { type: 'boolean', default: 'false', nullable: false };
      const sql = postgresDialect.addColumn('users', 'is_active', def);

      expect(sql).toContain('DEFAULT false');
    });

    it('should add unique column', () => {
      const def: ColumnDefinition = { type: 'string', unique: true, nullable: false };
      const sql = postgresDialect.addColumn('users', 'email', def);

      expect(sql).toContain('UNIQUE');
    });
  });

  describe('dropColumn', () => {
    it('should drop column', () => {
      const sql = postgresDialect.dropColumn('users', 'old_field');
      expect(sql).toBe('ALTER TABLE "users" DROP COLUMN "old_field"');
    });
  });

  describe('dropTable', () => {
    it('should drop table with cascade', () => {
      const sql = postgresDialect.dropTable('users');
      expect(sql).toBe('DROP TABLE IF EXISTS "users" CASCADE');
    });
  });

  describe('createIndex', () => {
    it('should create simple index', () => {
      const sql = postgresDialect.createIndex('users', { columns: ['email'] });
      expect(sql).toContain('CREATE INDEX "idx_users_email" ON "users" ("email")');
    });

    it('should create unique index', () => {
      const sql = postgresDialect.createIndex('users', { columns: ['email'], unique: true });
      expect(sql).toContain('CREATE UNIQUE INDEX');
    });

    it('should create composite index', () => {
      const sql = postgresDialect.createIndex('users', {
        columns: ['org_id', 'role'],
        name: 'idx_org_role',
      });
      expect(sql).toContain('"org_id", "role"');
    });

    it('should create partial index with where clause', () => {
      const sql = postgresDialect.createIndex('users', {
        columns: ['email'],
        where: 'deleted_at IS NULL',
      });
      expect(sql).toContain('WHERE deleted_at IS NULL');
    });
  });

  describe('transactional DDL', () => {
    it('should support transactional DDL', () => {
      expect(postgresDialect.supportsTransactionalDDL).toBe(true);
    });
  });
});

describe('MySQL Dialect', () => {
  describe('mapType', () => {
    it('should map all column types correctly', () => {
      const typeMap: Record<ColumnType, string> = {
        uuid: 'CHAR(36)',
        string: 'VARCHAR(255)',
        text: 'TEXT',
        integer: 'INT',
        bigint: 'BIGINT',
        float: 'DOUBLE',
        decimal: 'DECIMAL(10,2)',
        boolean: 'TINYINT(1)',
        datetime: 'DATETIME',
        date: 'DATE',
        time: 'TIME',
        json: 'JSON',
        binary: 'BLOB',
      };

      for (const [type, expected] of Object.entries(typeMap)) {
        expect(mysqlDialect.mapType(type as ColumnType)).toBe(expected);
      }
    });

    it('should return VARCHAR(255) for unknown types', () => {
      expect(mysqlDialect.mapType('unknown' as ColumnType)).toBe('VARCHAR(255)');
    });
  });

  describe('createTable', () => {
    it('should create table with InnoDB engine and utf8mb4 charset', () => {
      const def: TableDefinition = {
        columns: {
          id: { type: 'uuid', primaryKey: true },
        },
      };

      const sql = mysqlDialect.createTable('users', def);

      expect(sql).toContain('ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    });

    it('should use backticks for identifiers', () => {
      const def: TableDefinition = {
        columns: {
          id: { type: 'uuid', primaryKey: true },
          name: { type: 'string' },
        },
      };

      const sql = mysqlDialect.createTable('users', def);

      expect(sql).toContain('CREATE TABLE `users`');
      expect(sql).toContain('`id` CHAR(36) PRIMARY KEY');
      expect(sql).toContain('`name` VARCHAR(255)');
    });

    it('should convert gen_random_uuid() to UUID()', () => {
      const def: TableDefinition = {
        columns: {
          id: { type: 'uuid', primaryKey: true, default: 'gen_random_uuid()' },
        },
      };

      const sql = mysqlDialect.createTable('users', def);

      expect(sql).toContain('DEFAULT (UUID())');
    });

    it('should add foreign keys as separate constraints', () => {
      const def: TableDefinition = {
        columns: {
          id: { type: 'uuid', primaryKey: true },
          user_id: {
            type: 'uuid',
            references: {
              table: 'users',
              column: 'id',
              onDelete: 'CASCADE',
            },
          },
        },
      };

      const sql = mysqlDialect.createTable('posts', def);

      expect(sql).toContain('CONSTRAINT `fk_posts_user_id`');
      expect(sql).toContain('FOREIGN KEY (`user_id`)');
      expect(sql).toContain('REFERENCES `users`(`id`)');
      expect(sql).toContain('ON DELETE CASCADE');
    });
  });

  describe('addColumn', () => {
    it('should add column with backticks', () => {
      const def: ColumnDefinition = { type: 'string', nullable: false };
      const sql = mysqlDialect.addColumn('users', 'name', def);

      expect(sql).toBe('ALTER TABLE `users` ADD COLUMN `name` VARCHAR(255) NOT NULL');
    });
  });

  describe('dropIndex', () => {
    it('should require table name', () => {
      expect(() => mysqlDialect.dropIndex('idx_test')).toThrow(
        'MySQL requires table name for DROP INDEX'
      );
    });

    it('should drop index with table name', () => {
      const sql = mysqlDialect.dropIndex('idx_test', 'users');
      expect(sql).toBe('DROP INDEX `idx_test` ON `users`');
    });
  });

  describe('transactional DDL', () => {
    it('should not support transactional DDL', () => {
      expect(mysqlDialect.supportsTransactionalDDL).toBe(false);
    });
  });
});

describe('SQLite Dialect', () => {
  describe('mapType', () => {
    it('should map all column types correctly', () => {
      const typeMap: Record<ColumnType, string> = {
        uuid: 'TEXT',
        string: 'TEXT',
        text: 'TEXT',
        integer: 'INTEGER',
        bigint: 'INTEGER',
        float: 'REAL',
        decimal: 'REAL',
        boolean: 'INTEGER',
        datetime: 'TEXT',
        date: 'TEXT',
        time: 'TEXT',
        json: 'TEXT',
        binary: 'BLOB',
      };

      for (const [type, expected] of Object.entries(typeMap)) {
        expect(sqliteDialect.mapType(type as ColumnType)).toBe(expected);
      }
    });

    it('should return TEXT for unknown types', () => {
      expect(sqliteDialect.mapType('unknown' as ColumnType)).toBe('TEXT');
    });
  });

  describe('createTable', () => {
    it('should use double quotes for identifiers', () => {
      const def: TableDefinition = {
        columns: {
          id: { type: 'uuid', primaryKey: true },
          name: { type: 'string' },
        },
      };

      const sql = sqliteDialect.createTable('users', def);

      expect(sql).toContain('CREATE TABLE "users"');
      expect(sql).toContain('"id" TEXT PRIMARY KEY');
      expect(sql).toContain('"name" TEXT');
    });

    it('should convert gen_random_uuid() to SQLite UUID expression', () => {
      const def: TableDefinition = {
        columns: {
          id: { type: 'uuid', primaryKey: true, default: 'gen_random_uuid()' },
        },
      };

      const sql = sqliteDialect.createTable('users', def);

      expect(sql).toContain('DEFAULT (lower(hex(randomblob(4)))');
    });

    it('should convert now() to datetime("now")', () => {
      const def: TableDefinition = {
        columns: {
          id: { type: 'uuid', primaryKey: true },
          created_at: { type: 'datetime', default: 'now()' },
        },
      };

      const sql = sqliteDialect.createTable('users', def);

      expect(sql).toContain("DEFAULT datetime('now')");
    });

    it('should convert NOW() to datetime("now")', () => {
      const def: TableDefinition = {
        columns: {
          id: { type: 'uuid', primaryKey: true },
          created_at: { type: 'datetime', default: 'NOW()' },
        },
      };

      const sql = sqliteDialect.createTable('users', def);

      expect(sql).toContain("DEFAULT datetime('now')");
    });

    it('should handle inline foreign keys', () => {
      const def: TableDefinition = {
        columns: {
          id: { type: 'uuid', primaryKey: true },
          user_id: {
            type: 'uuid',
            references: {
              table: 'users',
              column: 'id',
              onDelete: 'CASCADE',
            },
          },
        },
      };

      const sql = sqliteDialect.createTable('posts', def);

      expect(sql).toContain('REFERENCES "users"("id")');
      expect(sql).toContain('ON DELETE CASCADE');
    });
  });

  describe('alterColumn', () => {
    it('should throw error with helpful message', () => {
      const def: ColumnDefinition = { type: 'string' };

      expect(() => sqliteDialect.alterColumn('users', 'name', def)).toThrow(
        'SQLite does not support ALTER COLUMN'
      );
      expect(() => sqliteDialect.alterColumn('users', 'name', def)).toThrow(
        'Create new table with desired schema'
      );
    });
  });

  describe('addForeignKey', () => {
    it('should throw error with helpful message', () => {
      expect(() => sqliteDialect.addForeignKey('posts', 'user_id', 'users', 'id')).toThrow(
        'SQLite does not support adding foreign keys after table creation'
      );
    });
  });

  describe('dropForeignKey', () => {
    it('should throw error with helpful message', () => {
      expect(() => sqliteDialect.dropForeignKey('posts', 'fk_user')).toThrow(
        'SQLite does not support dropping foreign keys'
      );
    });
  });

  describe('transactional DDL', () => {
    it('should support transactional DDL', () => {
      expect(sqliteDialect.supportsTransactionalDDL).toBe(true);
    });
  });
});

describe('Dialect Comparison', () => {
  describe('identifier quoting', () => {
    it('should use correct quote style per dialect', () => {
      const def: TableDefinition = {
        columns: { id: { type: 'uuid', primaryKey: true } },
      };

      const pgSql = postgresDialect.createTable('test', def);
      const mysqlSql = mysqlDialect.createTable('test', def);
      const sqliteSql = sqliteDialect.createTable('test', def);

      expect(pgSql).toContain('"test"');
      expect(mysqlSql).toContain('`test`');
      expect(sqliteSql).toContain('"test"');
    });
  });

  describe('UUID handling', () => {
    it('should map UUID type differently', () => {
      expect(postgresDialect.mapType('uuid')).toBe('UUID');
      expect(mysqlDialect.mapType('uuid')).toBe('CHAR(36)');
      expect(sqliteDialect.mapType('uuid')).toBe('TEXT');
    });
  });

  describe('JSON handling', () => {
    it('should use appropriate JSON type', () => {
      expect(postgresDialect.mapType('json')).toBe('JSONB');
      expect(mysqlDialect.mapType('json')).toBe('JSON');
      expect(sqliteDialect.mapType('json')).toBe('TEXT');
    });
  });

  describe('datetime handling', () => {
    it('should use appropriate datetime type', () => {
      expect(postgresDialect.mapType('datetime')).toBe('TIMESTAMPTZ');
      expect(mysqlDialect.mapType('datetime')).toBe('DATETIME');
      expect(sqliteDialect.mapType('datetime')).toBe('TEXT');
    });
  });

  describe('transactional DDL support', () => {
    it('should report correct transactional DDL support', () => {
      expect(postgresDialect.supportsTransactionalDDL).toBe(true);
      expect(mysqlDialect.supportsTransactionalDDL).toBe(false);
      expect(sqliteDialect.supportsTransactionalDDL).toBe(true);
    });
  });
});

describe('Edge Cases', () => {
  describe('column with all options', () => {
    it('should handle PostgreSQL column with all options', () => {
      const def: TableDefinition = {
        columns: {
          email: {
            type: 'string',
            nullable: false,
            unique: true,
            default: "'default@example.com'",
          },
        },
      };

      const sql = postgresDialect.createTable('test', def);

      expect(sql).toContain('TEXT');
      expect(sql).toContain('NOT NULL');
      expect(sql).toContain('UNIQUE');
      expect(sql).toContain("DEFAULT 'default@example.com'");
    });
  });

  describe('composite primary key with foreign keys', () => {
    it('should handle complex table definition', () => {
      const def: TableDefinition = {
        columns: {
          user_id: {
            type: 'uuid',
            references: { table: 'users', column: 'id', onDelete: 'CASCADE' },
          },
          org_id: {
            type: 'uuid',
            references: { table: 'orgs', column: 'id', onDelete: 'CASCADE' },
          },
          role: { type: 'string', nullable: false },
        },
        primaryKey: ['user_id', 'org_id'],
      };

      const sql = postgresDialect.createTable('memberships', def);

      expect(sql).toContain('PRIMARY KEY ("user_id", "org_id")');
      expect(sql).toContain('REFERENCES "users"("id")');
      expect(sql).toContain('REFERENCES "orgs"("id")');
    });
  });

  describe('empty table definitions', () => {
    it('should handle table with single column', () => {
      const def: TableDefinition = {
        columns: {
          id: { type: 'uuid', primaryKey: true },
        },
      };

      expect(() => postgresDialect.createTable('minimal', def)).not.toThrow();
      expect(() => mysqlDialect.createTable('minimal', def)).not.toThrow();
      expect(() => sqliteDialect.createTable('minimal', def)).not.toThrow();
    });
  });
});
