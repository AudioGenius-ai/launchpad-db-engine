import { describe, expect, it } from 'vitest';
import { type TypeGeneratorOptions, generateTypes, generateZodSchemas } from './generator.js';
import type { SchemaDefinition } from './index.js';

const createTestSchema = (): Map<string, SchemaDefinition> => {
  const schemaMap = new Map<string, SchemaDefinition>();
  schemaMap.set('myapp', {
    tables: {
      users: {
        columns: {
          id: { type: 'uuid', primaryKey: true, default: 'gen_random_uuid()' },
          email: { type: 'string', unique: true },
          name: { type: 'string', nullable: true },
          age: { type: 'integer', nullable: true },
          is_active: { type: 'boolean', default: 'true' },
          created_at: { type: 'datetime', default: 'NOW()' },
          updated_at: { type: 'datetime', default: 'NOW()' },
        },
      },
      posts: {
        columns: {
          id: { type: 'uuid', primaryKey: true, default: 'gen_random_uuid()' },
          title: { type: 'string' },
          content: { type: 'text', nullable: true },
          author_id: {
            type: 'uuid',
            references: { table: 'users', column: 'id', onDelete: 'CASCADE' },
          },
          metadata: { type: 'json', nullable: true },
          created_at: { type: 'datetime', default: 'NOW()' },
          updated_at: { type: 'datetime', default: 'NOW()' },
        },
      },
    },
  });
  return schemaMap;
};

const createTenantSchema = (): Map<string, SchemaDefinition> => {
  const schemaMap = new Map<string, SchemaDefinition>();
  schemaMap.set('tenant_app', {
    tables: {
      documents: {
        columns: {
          id: { type: 'uuid', primaryKey: true, default: 'gen_random_uuid()' },
          app_id: { type: 'uuid', tenant: true },
          organization_id: { type: 'uuid', tenant: true },
          title: { type: 'string' },
          created_at: { type: 'datetime', default: 'NOW()' },
        },
      },
    },
  });
  return schemaMap;
};

describe('generateTypes', () => {
  it('generates basic row types', () => {
    const schema = createTestSchema();
    const result = generateTypes(schema, { includeInsertTypes: false, includeUpdateTypes: false });

    expect(result).toContain('export namespace Myapp {');
    expect(result).toContain('export interface Users {');
    expect(result).toContain('id: string;');
    expect(result).toContain('email: string;');
    expect(result).toContain('name: string | null;');
    expect(result).toContain('age: number | null;');
    expect(result).toContain('is_active: boolean;');
    expect(result).toContain('created_at: Date;');
    expect(result).toContain('updated_at: Date;');
  });

  it('generates Insert types that omit auto-generated fields', () => {
    const schema = createTestSchema();
    const result = generateTypes(schema, { includeInsertTypes: true, includeUpdateTypes: false });

    expect(result).toContain('export interface UsersInsert {');
    const insertMatch = result.match(/export interface UsersInsert \{[\s\S]*?\}/);
    expect(insertMatch).toBeTruthy();
    const insertBlock = insertMatch![0];
    expect(insertBlock).not.toContain('id:');
    expect(insertBlock).not.toContain('created_at:');
    expect(insertBlock).not.toContain('updated_at:');
    expect(insertBlock).toContain('email: string;');
    expect(insertBlock).toContain('name?: string;');
    expect(insertBlock).toContain('is_active?: boolean;');
  });

  it('generates Update types with all fields optional', () => {
    const schema = createTestSchema();
    const result = generateTypes(schema, { includeInsertTypes: false, includeUpdateTypes: true });

    expect(result).toContain('export interface UsersUpdate {');
    const updateMatch = result.match(/export interface UsersUpdate \{[\s\S]*?\}/);
    expect(updateMatch).toBeTruthy();
    const updateBlock = updateMatch![0];
    expect(updateBlock).not.toContain('id:');
    expect(updateBlock).not.toContain('created_at:');
    expect(updateBlock).toContain('email?: string | null;');
    expect(updateBlock).toContain('name?: string | null;');
    expect(updateBlock).toContain('updated_at?: Date | null;');
  });

  it('omits tenant columns from Insert types by default', () => {
    const schema = createTenantSchema();
    const result = generateTypes(schema, { includeInsertTypes: true });

    expect(result).toContain('export interface DocumentsInsert {');
    expect(result).not.toMatch(/DocumentsInsert[\s\S]*?app_id/);
    expect(result).not.toMatch(/DocumentsInsert[\s\S]*?organization_id/);
    expect(result).toContain('title: string;');
  });

  it('includes tenant columns when omitTenantColumns is false', () => {
    const schema = createTenantSchema();
    const result = generateTypes(schema, {
      includeInsertTypes: true,
      omitTenantColumns: false,
    });

    expect(result).toContain('app_id: string;');
    expect(result).toContain('organization_id: string;');
  });

  it('generates TableName union type', () => {
    const schema = createTestSchema();
    const result = generateTypes(schema);

    expect(result).toContain("export type TableName = 'users' | 'posts';");
  });

  it('generates Tables interface', () => {
    const schema = createTestSchema();
    const result = generateTypes(schema);

    expect(result).toContain('export interface Tables {');
    expect(result).toContain('users: Users;');
    expect(result).toContain('posts: Posts;');
  });

  it('generates AllSchemas type', () => {
    const schema = createTestSchema();
    const result = generateTypes(schema);

    expect(result).toContain('export type AllSchemas = {');
    expect(result).toContain('myapp: typeof Myapp;');
  });

  it('handles all column types correctly', () => {
    const schemaMap = new Map<string, SchemaDefinition>();
    schemaMap.set('types_test', {
      tables: {
        all_types: {
          columns: {
            col_uuid: { type: 'uuid' },
            col_string: { type: 'string' },
            col_text: { type: 'text' },
            col_integer: { type: 'integer' },
            col_bigint: { type: 'bigint' },
            col_float: { type: 'float' },
            col_decimal: { type: 'decimal' },
            col_boolean: { type: 'boolean' },
            col_datetime: { type: 'datetime' },
            col_date: { type: 'date' },
            col_time: { type: 'time' },
            col_json: { type: 'json' },
            col_binary: { type: 'binary' },
          },
        },
      },
    });

    const result = generateTypes(schemaMap);

    expect(result).toContain('col_uuid: string;');
    expect(result).toContain('col_string: string;');
    expect(result).toContain('col_text: string;');
    expect(result).toContain('col_integer: number;');
    expect(result).toContain('col_bigint: number;');
    expect(result).toContain('col_float: number;');
    expect(result).toContain('col_decimal: number;');
    expect(result).toContain('col_boolean: boolean;');
    expect(result).toContain('col_datetime: Date;');
    expect(result).toContain('col_date: Date;');
    expect(result).toContain('col_time: string;');
    expect(result).toContain('col_json: Record<string, unknown>;');
    expect(result).toContain('col_binary: Buffer;');
  });
});

describe('generateZodSchemas', () => {
  it('generates Zod import statement', () => {
    const schema = createTestSchema();
    const result = generateZodSchemas(schema);

    expect(result).toContain("import { z } from 'zod';");
  });

  it('generates row schema', () => {
    const schema = createTestSchema();
    const result = generateZodSchemas(schema);

    expect(result).toContain('export const myappUsersSchema = z.object({');
    expect(result).toContain('id: z.string().uuid(),');
    expect(result).toContain('email: z.string(),');
    expect(result).toContain('name: z.string().nullable(),');
    expect(result).toContain('age: z.number().int().nullable(),');
    expect(result).toContain('is_active: z.boolean(),');
    expect(result).toContain('created_at: z.coerce.date(),');
  });

  it('generates Insert schema that omits auto-generated fields', () => {
    const schema = createTestSchema();
    const result = generateZodSchemas(schema);

    expect(result).toContain('export const myappUsersInsertSchema = z.object({');
    const insertMatch = result.match(
      /export const myappUsersInsertSchema = z\.object\(\{[\s\S]*?\}\);/
    );
    expect(insertMatch).toBeTruthy();
    const insertBlock = insertMatch![0];
    expect(insertBlock).not.toContain('id:');
    expect(insertBlock).not.toContain('created_at:');
    expect(insertBlock).not.toContain('updated_at:');
    expect(insertBlock).toContain('email: z.string(),');
    expect(insertBlock).toContain('name: z.string().optional(),');
  });

  it('generates Update schema with all fields optional and nullable', () => {
    const schema = createTestSchema();
    const result = generateZodSchemas(schema);

    expect(result).toContain('export const myappUsersUpdateSchema = z.object({');
    const updateMatch = result.match(
      /export const myappUsersUpdateSchema = z\.object\(\{[\s\S]*?\}\);/
    );
    expect(updateMatch).toBeTruthy();
    const updateBlock = updateMatch![0];
    expect(updateBlock).not.toContain('id:');
    expect(updateBlock).not.toContain('created_at:');
    expect(updateBlock).toContain('email: z.string().nullable().optional(),');
    expect(updateBlock).toContain('updated_at: z.coerce.date().nullable().optional(),');
  });

  it('generates type inference exports', () => {
    const schema = createTestSchema();
    const result = generateZodSchemas(schema);

    expect(result).toContain('export type Users = z.infer<typeof myappUsersSchema>;');
    expect(result).toContain('export type UsersInsert = z.infer<typeof myappUsersInsertSchema>;');
    expect(result).toContain('export type UsersUpdate = z.infer<typeof myappUsersUpdateSchema>;');
  });

  it('omits tenant columns from Insert schemas by default', () => {
    const schema = createTenantSchema();
    const result = generateZodSchemas(schema);

    expect(result).not.toMatch(/tenantAppDocumentsInsertSchema[\s\S]*?app_id:/);
    expect(result).not.toMatch(/tenantAppDocumentsInsertSchema[\s\S]*?organization_id:/);
  });

  it('respects includeInsertTypes option', () => {
    const schema = createTestSchema();
    const result = generateZodSchemas(schema, { includeInsertTypes: false });

    expect(result).not.toContain('myappUsersInsertSchema');
    expect(result).not.toContain('UsersInsert');
  });

  it('respects includeUpdateTypes option', () => {
    const schema = createTestSchema();
    const result = generateZodSchemas(schema, { includeUpdateTypes: false });

    expect(result).not.toContain('myappUsersUpdateSchema');
    expect(result).not.toContain('UsersUpdate');
  });

  it('handles all column types with correct Zod validators', () => {
    const schemaMap = new Map<string, SchemaDefinition>();
    schemaMap.set('types_test', {
      tables: {
        all_types: {
          columns: {
            col_uuid: { type: 'uuid' },
            col_string: { type: 'string' },
            col_text: { type: 'text' },
            col_integer: { type: 'integer' },
            col_bigint: { type: 'bigint' },
            col_float: { type: 'float' },
            col_decimal: { type: 'decimal' },
            col_boolean: { type: 'boolean' },
            col_datetime: { type: 'datetime' },
            col_date: { type: 'date' },
            col_time: { type: 'time' },
            col_json: { type: 'json' },
            col_binary: { type: 'binary' },
          },
        },
      },
    });

    const result = generateZodSchemas(schemaMap);

    expect(result).toContain('col_uuid: z.string().uuid(),');
    expect(result).toContain('col_string: z.string(),');
    expect(result).toContain('col_text: z.string(),');
    expect(result).toContain('col_integer: z.number().int(),');
    expect(result).toContain('col_bigint: z.number().int(),');
    expect(result).toContain('col_float: z.number(),');
    expect(result).toContain('col_decimal: z.number(),');
    expect(result).toContain('col_boolean: z.boolean(),');
    expect(result).toContain('col_datetime: z.coerce.date(),');
    expect(result).toContain('col_date: z.coerce.date(),');
    expect(result).toContain('col_time: z.string(),');
    expect(result).toContain('col_json: z.record(z.unknown()),');
    expect(result).toContain('col_binary: z.instanceof(Buffer),');
  });

  it('handles multiple schemas', () => {
    const schemaMap = new Map<string, SchemaDefinition>();
    schemaMap.set('app_one', {
      tables: { items: { columns: { id: { type: 'uuid' } } } },
    });
    schemaMap.set('app_two', {
      tables: { things: { columns: { id: { type: 'uuid' } } } },
    });

    const result = generateZodSchemas(schemaMap);

    expect(result).toContain('// ==================== AppOne Schema ====================');
    expect(result).toContain('// ==================== AppTwo Schema ====================');
    expect(result).toContain('export const appOneItemsSchema');
    expect(result).toContain('export const appTwoThingsSchema');
  });
});

describe('TypeGeneratorOptions', () => {
  it('defaults to including Insert and Update types', () => {
    const schema = createTestSchema();
    const result = generateTypes(schema);

    expect(result).toContain('UsersInsert');
    expect(result).toContain('UsersUpdate');
    expect(result).toContain('PostsInsert');
    expect(result).toContain('PostsUpdate');
  });

  it('can disable Insert types', () => {
    const schema = createTestSchema();
    const result = generateTypes(schema, { includeInsertTypes: false });

    expect(result).not.toContain('UsersInsert');
    expect(result).toContain('UsersUpdate');
  });

  it('can disable Update types', () => {
    const schema = createTestSchema();
    const result = generateTypes(schema, { includeUpdateTypes: false });

    expect(result).toContain('UsersInsert');
    expect(result).not.toContain('UsersUpdate');
  });

  it('can disable both Insert and Update types', () => {
    const schema = createTestSchema();
    const result = generateTypes(schema, {
      includeInsertTypes: false,
      includeUpdateTypes: false,
    });

    expect(result).not.toContain('UsersInsert');
    expect(result).not.toContain('UsersUpdate');
    expect(result).toContain('export interface Users {');
  });
});

describe('Custom Suffix Options', () => {
  it('uses custom insert suffix for TypeScript interfaces', () => {
    const schema = createTestSchema();
    const result = generateTypes(schema, { insertSuffix: 'Create' });

    expect(result).toContain('export interface UsersCreate {');
    expect(result).toContain('export interface PostsCreate {');
    expect(result).not.toContain('UsersInsert');
    expect(result).not.toContain('PostsInsert');
  });

  it('uses custom update suffix for TypeScript interfaces', () => {
    const schema = createTestSchema();
    const result = generateTypes(schema, { updateSuffix: 'Patch' });

    expect(result).toContain('export interface UsersPatch {');
    expect(result).toContain('export interface PostsPatch {');
    expect(result).not.toContain('UsersUpdate');
    expect(result).not.toContain('PostsUpdate');
  });

  it('uses both custom suffixes together for TypeScript interfaces', () => {
    const schema = createTestSchema();
    const result = generateTypes(schema, {
      insertSuffix: 'New',
      updateSuffix: 'Edit',
    });

    expect(result).toContain('export interface UsersNew {');
    expect(result).toContain('export interface UsersEdit {');
    expect(result).toContain('export interface PostsNew {');
    expect(result).toContain('export interface PostsEdit {');
    expect(result).not.toContain('UsersInsert');
    expect(result).not.toContain('UsersUpdate');
  });

  it('uses custom insert suffix for Zod schemas', () => {
    const schema = createTestSchema();
    const result = generateZodSchemas(schema, { insertSuffix: 'Create' });

    expect(result).toContain('export const myappUsersCreateSchema = z.object({');
    expect(result).toContain('export type UsersCreate = z.infer<typeof myappUsersCreateSchema>;');
    expect(result).not.toContain('myappUsersInsertSchema');
    expect(result).not.toContain('UsersInsert');
  });

  it('uses custom update suffix for Zod schemas', () => {
    const schema = createTestSchema();
    const result = generateZodSchemas(schema, { updateSuffix: 'Patch' });

    expect(result).toContain('export const myappUsersPatchSchema = z.object({');
    expect(result).toContain('export type UsersPatch = z.infer<typeof myappUsersPatchSchema>;');
    expect(result).not.toContain('myappUsersUpdateSchema');
    expect(result).not.toContain('UsersUpdate');
  });

  it('uses both custom suffixes together for Zod schemas', () => {
    const schema = createTestSchema();
    const result = generateZodSchemas(schema, {
      insertSuffix: 'New',
      updateSuffix: 'Edit',
    });

    expect(result).toContain('export const myappUsersNewSchema = z.object({');
    expect(result).toContain('export const myappUsersEditSchema = z.object({');
    expect(result).toContain('export type UsersNew = z.infer<typeof myappUsersNewSchema>;');
    expect(result).toContain('export type UsersEdit = z.infer<typeof myappUsersEditSchema>;');
  });

  it('defaults to Insert and Update suffixes when not specified', () => {
    const schema = createTestSchema();
    const typesResult = generateTypes(schema);
    const zodResult = generateZodSchemas(schema);

    expect(typesResult).toContain('UsersInsert');
    expect(typesResult).toContain('UsersUpdate');
    expect(zodResult).toContain('myappUsersInsertSchema');
    expect(zodResult).toContain('myappUsersUpdateSchema');
  });
});
