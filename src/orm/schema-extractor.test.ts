import { beforeEach, describe, expect, it } from 'vitest';
import { Column, Default, Entity, Index, PrimaryKey, TenantColumn, Unique } from './decorators.js';
import { TenantEntity, WithTenantColumns } from './entity.js';
import { metadataStorage } from './metadata.js';
import {
  columnToProperty,
  extractSchemaFromEntities,
  extractSchemaFromEntity,
  getEntityColumns,
  getEntityTableName,
  propertyToColumn,
} from './schema-extractor.js';

describe('Schema Extractor', () => {
  beforeEach(() => {
    metadataStorage.clear();
  });

  describe('extractSchemaFromEntity', () => {
    it('should extract schema from simple entity', () => {
      @Entity('users')
      class User {
        @PrimaryKey()
        @Column('uuid')
        id!: string;

        @Column('string')
        name!: string;

        @Unique()
        @Column('string')
        email!: string;
      }

      const schema = extractSchemaFromEntity(User);

      expect(schema.tables).toHaveProperty('users');
      expect(schema.tables.users.columns).toHaveProperty('id');
      expect(schema.tables.users.columns).toHaveProperty('name');
      expect(schema.tables.users.columns).toHaveProperty('email');

      expect(schema.tables.users.columns.id.type).toBe('uuid');
      expect(schema.tables.users.columns.id.primaryKey).toBe(true);
      expect(schema.tables.users.columns.email.unique).toBe(true);
    });

    it('should extract schema from entity with tenant columns', () => {
      @WithTenantColumns()
      @Entity('secrets')
      class Secret extends TenantEntity {
        @PrimaryKey()
        @Column('uuid')
        id!: string;

        @Column('string')
        key!: string;

        @Column('text')
        encryptedValue!: string;
      }

      const schema = extractSchemaFromEntity(Secret);

      expect(schema.tables.secrets.columns).toHaveProperty('app_id');
      expect(schema.tables.secrets.columns).toHaveProperty('organization_id');
      expect(schema.tables.secrets.columns.app_id.tenant).toBe(true);
      expect(schema.tables.secrets.columns.organization_id.tenant).toBe(true);
    });

    it('should extract indexes', () => {
      @Index({ columns: ['email'], unique: true, name: 'idx_users_email' })
      @Index({ columns: ['created_at'], where: 'deleted_at IS NULL' })
      @Entity('users')
      class User {
        @PrimaryKey()
        @Column('uuid')
        id!: string;

        @Column('string')
        email!: string;

        @Column('datetime')
        createdAt!: Date;
      }

      const schema = extractSchemaFromEntity(User);

      expect(schema.tables.users.indexes).toHaveLength(2);
      const emailIndex = schema.tables.users.indexes!.find((i) => i.columns.includes('email'));
      const createdAtIndex = schema.tables.users.indexes!.find((i) =>
        i.columns.includes('created_at')
      );
      expect(emailIndex).toBeDefined();
      expect(emailIndex!.unique).toBe(true);
      expect(emailIndex!.name).toBe('idx_users_email');
      expect(createdAtIndex).toBeDefined();
      expect(createdAtIndex!.where).toBe('deleted_at IS NULL');
    });

    it('should extract column defaults', () => {
      @Entity('posts')
      class Post {
        @PrimaryKey()
        @Column('uuid')
        id!: string;

        @Default('NOW()')
        @Column('datetime')
        createdAt!: Date;

        @Default("'draft'")
        @Column('string')
        status!: string;
      }

      const schema = extractSchemaFromEntity(Post);

      expect(schema.tables.posts.columns.created_at.default).toBe('NOW()');
      expect(schema.tables.posts.columns.status.default).toBe("'draft'");
    });

    it('should extract foreign key references', () => {
      @Entity('posts')
      class Post {
        @PrimaryKey()
        @Column('uuid')
        id!: string;

        @Column('uuid', {
          references: {
            table: 'users',
            column: 'id',
            onDelete: 'CASCADE',
          },
        })
        authorId!: string;
      }

      const schema = extractSchemaFromEntity(Post);

      expect(schema.tables.posts.columns.author_id.references).toEqual({
        table: 'users',
        column: 'id',
        onDelete: 'CASCADE',
      });
    });

    it('should throw error for non-decorated class', () => {
      class NotAnEntity {
        id!: string;
      }

      expect(() => extractSchemaFromEntity(NotAnEntity)).toThrow(
        'Entity NotAnEntity is not decorated with @Entity'
      );
    });
  });

  describe('extractSchemaFromEntities', () => {
    it('should extract schema from multiple entities', () => {
      @Entity('users')
      class User {
        @PrimaryKey()
        @Column('uuid')
        id!: string;

        @Column('string')
        name!: string;
      }

      @Entity('posts')
      class Post {
        @PrimaryKey()
        @Column('uuid')
        id!: string;

        @Column('string')
        title!: string;

        @Column('uuid')
        userId!: string;
      }

      const schema = extractSchemaFromEntities([User, Post]);

      expect(Object.keys(schema.tables)).toHaveLength(2);
      expect(schema.tables).toHaveProperty('users');
      expect(schema.tables).toHaveProperty('posts');
    });
  });

  describe('getEntityTableName', () => {
    it('should return table name for entity', () => {
      @Entity('custom_users')
      class User {
        @Column('uuid')
        id!: string;
      }

      expect(getEntityTableName(User)).toBe('custom_users');
    });

    it('should throw for non-entity', () => {
      class NotEntity {}
      expect(() => getEntityTableName(NotEntity)).toThrow('is not decorated with @Entity');
    });
  });

  describe('getEntityColumns', () => {
    it('should return column mapping', () => {
      @Entity('users')
      class User {
        @Column('uuid')
        id!: string;

        @Column('string')
        firstName!: string;

        @Column('string')
        lastName!: string;
      }

      const columns = getEntityColumns(User);

      expect(columns.get('id')).toBe('id');
      expect(columns.get('firstName')).toBe('first_name');
      expect(columns.get('lastName')).toBe('last_name');
    });
  });

  describe('propertyToColumn', () => {
    it('should convert property name to column name', () => {
      @Entity('users')
      class User {
        @Column('datetime')
        createdAt!: Date;
      }

      expect(propertyToColumn(User, 'createdAt')).toBe('created_at');
    });

    it('should throw for non-existent property', () => {
      @Entity('users')
      class User {
        @Column('uuid')
        id!: string;
      }

      expect(() => propertyToColumn(User, 'nonExistent')).toThrow('Property nonExistent not found');
    });
  });

  describe('columnToProperty', () => {
    it('should convert column name to property name', () => {
      @Entity('users')
      class User {
        @Column('datetime')
        createdAt!: Date;
      }

      expect(columnToProperty(User, 'created_at')).toBe('createdAt');
    });

    it('should throw for non-existent column', () => {
      @Entity('users')
      class User {
        @Column('uuid')
        id!: string;
      }

      expect(() => columnToProperty(User, 'non_existent')).toThrow('Column non_existent not found');
    });
  });
});
