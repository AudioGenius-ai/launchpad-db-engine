import { beforeEach, describe, expect, it } from 'vitest';
import {
  Column,
  Default,
  Entity,
  Index,
  ManyToMany,
  ManyToOne,
  Nullable,
  OneToMany,
  OneToOne,
  PrimaryKey,
  TenantColumn,
  Unique,
} from './decorators.js';
import { metadataStorage } from './metadata.js';

describe('Entity Decorators', () => {
  beforeEach(() => {
    metadataStorage.clear();
  });

  describe('@Entity', () => {
    it('should register entity with explicit table name', () => {
      @Entity('users_table')
      class User {
        @Column('uuid')
        id!: string;
      }

      const metadata = metadataStorage.getEntityMetadata(User);
      expect(metadata).toBeDefined();
      expect(metadata!.tableName).toBe('users_table');
    });

    it('should register entity with snake_case name from class name', () => {
      @Entity()
      class UserProfile {
        @Column('uuid')
        id!: string;
      }

      const metadata = metadataStorage.getEntityMetadata(UserProfile);
      expect(metadata!.tableName).toBe('user_profile');
    });

    it('should accept options object', () => {
      @Entity({ name: 'custom_table' })
      class TestEntity {
        @Column('uuid')
        id!: string;
      }

      const metadata = metadataStorage.getEntityMetadata(TestEntity);
      expect(metadata!.tableName).toBe('custom_table');
    });
  });

  describe('@Column', () => {
    it('should register column with type', () => {
      @Entity('test')
      class Test {
        @Column('uuid')
        id!: string;

        @Column('string')
        name!: string;

        @Column('integer')
        age!: number;
      }

      const metadata = metadataStorage.getEntityMetadata(Test);
      expect(metadata!.columns.get('id')!.type).toBe('uuid');
      expect(metadata!.columns.get('name')!.type).toBe('string');
      expect(metadata!.columns.get('age')!.type).toBe('integer');
    });

    it('should convert property names to snake_case', () => {
      @Entity('test')
      class Test {
        @Column('datetime')
        createdAt!: Date;

        @Column('string')
        firstName!: string;
      }

      const metadata = metadataStorage.getEntityMetadata(Test);
      expect(metadata!.columns.get('createdAt')!.columnName).toBe('created_at');
      expect(metadata!.columns.get('firstName')!.columnName).toBe('first_name');
    });

    it('should accept custom column name', () => {
      @Entity('test')
      class Test {
        @Column('string', { name: 'custom_column' })
        myProperty!: string;
      }

      const metadata = metadataStorage.getEntityMetadata(Test);
      expect(metadata!.columns.get('myProperty')!.columnName).toBe('custom_column');
    });

    it('should accept column options', () => {
      @Entity('test')
      class Test {
        @Column('string', { nullable: false, unique: true, default: "'unknown'" })
        status!: string;
      }

      const metadata = metadataStorage.getEntityMetadata(Test);
      const column = metadata!.columns.get('status')!;
      expect(column.nullable).toBe(false);
      expect(column.unique).toBe(true);
      expect(column.default).toBe("'unknown'");
    });

    it('should accept references for foreign keys', () => {
      @Entity('test')
      class Test {
        @Column('uuid', {
          references: {
            table: 'users',
            column: 'id',
            onDelete: 'CASCADE',
          },
        })
        userId!: string;
      }

      const metadata = metadataStorage.getEntityMetadata(Test);
      const column = metadata!.columns.get('userId')!;
      expect(column.references).toEqual({
        table: 'users',
        column: 'id',
        onDelete: 'CASCADE',
      });
    });
  });

  describe('@PrimaryKey', () => {
    it('should mark column as primary key', () => {
      @Entity('test')
      class Test {
        @PrimaryKey()
        @Column('uuid')
        id!: string;
      }

      const metadata = metadataStorage.getEntityMetadata(Test);
      expect(metadata!.columns.get('id')!.primaryKey).toBe(true);
      expect(metadata!.columns.get('id')!.nullable).toBe(false);
    });

    it('should work with multiple decorators', () => {
      @Entity('test')
      class Test {
        @Unique()
        @PrimaryKey()
        @Column('uuid')
        id!: string;
      }

      const metadata = metadataStorage.getEntityMetadata(Test);
      const column = metadata!.columns.get('id')!;
      expect(column.primaryKey).toBe(true);
      expect(column.unique).toBe(true);
    });
  });

  describe('@TenantColumn', () => {
    it('should mark column as tenant column', () => {
      @Entity('test')
      class Test {
        @TenantColumn()
        @Column('string')
        appId!: string;
      }

      const metadata = metadataStorage.getEntityMetadata(Test);
      const column = metadata!.columns.get('appId')!;
      expect(column.tenant).toBe(true);
      expect(column.nullable).toBe(false);
    });
  });

  describe('@Unique', () => {
    it('should mark column as unique', () => {
      @Entity('test')
      class Test {
        @Unique()
        @Column('string')
        email!: string;
      }

      const metadata = metadataStorage.getEntityMetadata(Test);
      expect(metadata!.columns.get('email')!.unique).toBe(true);
    });
  });

  describe('@Nullable', () => {
    it('should mark column as nullable', () => {
      @Entity('test')
      class Test {
        @Nullable()
        @Column('string')
        middleName!: string;
      }

      const metadata = metadataStorage.getEntityMetadata(Test);
      expect(metadata!.columns.get('middleName')!.nullable).toBe(true);
    });
  });

  describe('@Default', () => {
    it('should set default value', () => {
      @Entity('test')
      class Test {
        @Default('NOW()')
        @Column('datetime')
        createdAt!: Date;

        @Default("'active'")
        @Column('string')
        status!: string;
      }

      const metadata = metadataStorage.getEntityMetadata(Test);
      expect(metadata!.columns.get('createdAt')!.default).toBe('NOW()');
      expect(metadata!.columns.get('status')!.default).toBe("'active'");
    });
  });

  describe('@Index', () => {
    it('should register index on entity', () => {
      @Index({ columns: ['email'] })
      @Entity('test')
      class Test {
        @Column('string')
        email!: string;
      }

      const metadata = metadataStorage.getEntityMetadata(Test);
      expect(metadata!.indexes).toHaveLength(1);
      expect(metadata!.indexes[0].columns).toEqual(['email']);
    });

    it('should register composite index', () => {
      @Index({ columns: ['firstName', 'lastName'], name: 'idx_full_name' })
      @Entity('test')
      class Test {
        @Column('string')
        firstName!: string;

        @Column('string')
        lastName!: string;
      }

      const metadata = metadataStorage.getEntityMetadata(Test);
      expect(metadata!.indexes[0].columns).toEqual(['firstName', 'lastName']);
      expect(metadata!.indexes[0].name).toBe('idx_full_name');
    });

    it('should support unique index', () => {
      @Index({ columns: ['email'], unique: true })
      @Entity('test')
      class Test {
        @Column('string')
        email!: string;
      }

      const metadata = metadataStorage.getEntityMetadata(Test);
      expect(metadata!.indexes[0].unique).toBe(true);
    });

    it('should support partial index with where clause', () => {
      @Index({ columns: ['status'], where: "status = 'active'" })
      @Entity('test')
      class Test {
        @Column('string')
        status!: string;
      }

      const metadata = metadataStorage.getEntityMetadata(Test);
      expect(metadata!.indexes[0].where).toBe("status = 'active'");
    });
  });

  describe('Relationship Decorators', () => {
    it('@OneToMany should register one-to-many relation', () => {
      @Entity('posts')
      class Post {
        @Column('uuid')
        id!: string;
      }

      @Entity('users')
      class User {
        @Column('uuid')
        id!: string;

        @OneToMany(() => Post, 'user')
        posts!: Post[];
      }

      const metadata = metadataStorage.getEntityMetadata(User);
      const relation = metadata!.relations.get('posts')!;
      expect(relation.type).toBe('one-to-many');
      expect(relation.inverseSide).toBe('user');
    });

    it('@ManyToOne should register many-to-one relation', () => {
      @Entity('users')
      class User {
        @Column('uuid')
        id!: string;
      }

      @Entity('posts')
      class Post {
        @Column('uuid')
        id!: string;

        @ManyToOne(() => User, { foreignKey: 'user_id' })
        user!: User;
      }

      const metadata = metadataStorage.getEntityMetadata(Post);
      const relation = metadata!.relations.get('user')!;
      expect(relation.type).toBe('many-to-one');
      expect(relation.foreignKey).toBe('user_id');
    });

    it('@OneToOne should register one-to-one relation', () => {
      @Entity('profiles')
      class Profile {
        @Column('uuid')
        id!: string;
      }

      @Entity('users')
      class User {
        @Column('uuid')
        id!: string;

        @OneToOne(() => Profile, { foreignKey: 'profile_id' })
        profile!: Profile;
      }

      const metadata = metadataStorage.getEntityMetadata(User);
      const relation = metadata!.relations.get('profile')!;
      expect(relation.type).toBe('one-to-one');
      expect(relation.foreignKey).toBe('profile_id');
    });

    it('@ManyToMany should register many-to-many relation', () => {
      @Entity('tags')
      class Tag {
        @Column('uuid')
        id!: string;
      }

      @Entity('posts')
      class Post {
        @Column('uuid')
        id!: string;

        @ManyToMany(() => Tag, { joinTable: 'post_tags' })
        tags!: Tag[];
      }

      const metadata = metadataStorage.getEntityMetadata(Post);
      const relation = metadata!.relations.get('tags')!;
      expect(relation.type).toBe('many-to-many');
      expect(relation.joinTable).toBe('post_tags');
    });
  });
});
