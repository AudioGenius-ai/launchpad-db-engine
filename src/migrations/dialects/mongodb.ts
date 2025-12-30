import type {
  ColumnDefinition,
  ColumnType,
  IndexDefinition,
  TableDefinition,
} from '../../types/index.js';

export interface MongoMigrationOperation {
  operation:
    | 'createCollection'
    | 'dropCollection'
    | 'collMod'
    | 'createIndex'
    | 'dropIndex'
    | 'addValidator'
    | 'removeValidator';
  collection: string;
  options?: Record<string, unknown>;
  indexSpec?: {
    keys: Record<string, 1 | -1>;
    options?: {
      name?: string;
      unique?: boolean;
      sparse?: boolean;
    };
  };
}

export interface MongoDialect {
  name: 'mongodb';
  supportsTransactionalDDL: boolean;

  mapType(type: ColumnType): string;
  createTable(name: string, def: TableDefinition): MongoMigrationOperation;
  dropTable(name: string): MongoMigrationOperation;
  addColumn(table: string, column: string, def: ColumnDefinition): MongoMigrationOperation;
  dropColumn(table: string, column: string): MongoMigrationOperation;
  alterColumn(table: string, column: string, def: ColumnDefinition): MongoMigrationOperation;
  createIndex(table: string, index: IndexDefinition): MongoMigrationOperation;
  dropIndex(name: string, table: string): MongoMigrationOperation;
}

const COLUMN_TYPE_TO_BSON: Record<ColumnType, string | string[]> = {
  uuid: 'string',
  string: 'string',
  text: 'string',
  integer: 'int',
  bigint: 'long',
  float: 'double',
  decimal: 'decimal',
  boolean: 'bool',
  datetime: 'date',
  date: 'date',
  time: 'string',
  json: 'object',
  binary: 'binData',
};

function buildJsonSchema(def: TableDefinition): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [colName, colDef] of Object.entries(def.columns)) {
    const bsonType = COLUMN_TYPE_TO_BSON[colDef.type];

    properties[colName] = {
      bsonType: colDef.nullable ? [bsonType, 'null'] : bsonType,
    };

    if (!colDef.nullable && colDef.default === undefined) {
      required.push(colName);
    }
  }

  return {
    bsonType: 'object',
    required: required.length > 0 ? required : undefined,
    properties,
  };
}

export const mongoDialect: MongoDialect = {
  name: 'mongodb',
  supportsTransactionalDDL: true,

  mapType(type: ColumnType): string {
    const mapped = COLUMN_TYPE_TO_BSON[type];
    return Array.isArray(mapped) ? mapped[0] : mapped;
  },

  createTable(name: string, def: TableDefinition): MongoMigrationOperation {
    const jsonSchema = buildJsonSchema(def);

    return {
      operation: 'createCollection',
      collection: name,
      options: {
        validator: {
          $jsonSchema: jsonSchema,
        },
      },
    };
  },

  dropTable(name: string): MongoMigrationOperation {
    return {
      operation: 'dropCollection',
      collection: name,
    };
  },

  addColumn(table: string, column: string, def: ColumnDefinition): MongoMigrationOperation {
    const bsonType = this.mapType(def.type);
    return {
      operation: 'collMod',
      collection: table,
      options: {
        validatorAction: 'addProperty',
        property: column,
        schema: {
          bsonType: def.nullable ? [bsonType, 'null'] : bsonType,
        },
        required: !def.nullable && def.default === undefined,
      },
    };
  },

  dropColumn(table: string, column: string): MongoMigrationOperation {
    return {
      operation: 'collMod',
      collection: table,
      options: {
        validatorAction: 'removeProperty',
        property: column,
      },
    };
  },

  alterColumn(table: string, column: string, def: ColumnDefinition): MongoMigrationOperation {
    const bsonType = this.mapType(def.type);
    return {
      operation: 'collMod',
      collection: table,
      options: {
        validatorAction: 'modifyProperty',
        property: column,
        schema: {
          bsonType: def.nullable ? [bsonType, 'null'] : bsonType,
        },
      },
    };
  },

  createIndex(table: string, index: IndexDefinition): MongoMigrationOperation {
    const keys: Record<string, 1 | -1> = {};
    for (const col of index.columns) {
      keys[col] = 1;
    }

    return {
      operation: 'createIndex',
      collection: table,
      indexSpec: {
        keys,
        options: {
          name: index.name ?? `idx_${table}_${index.columns.join('_')}`,
          unique: index.unique ?? false,
        },
      },
    };
  },

  dropIndex(name: string, table: string): MongoMigrationOperation {
    return {
      operation: 'dropIndex',
      collection: table,
      options: { indexName: name },
    };
  },
};

export async function executeMongoMigration(
  db: unknown,
  operation: MongoMigrationOperation
): Promise<void> {
  const mongoDb = db as import('mongodb').Db;

  switch (operation.operation) {
    case 'createCollection': {
      await mongoDb.createCollection(operation.collection, operation.options);
      break;
    }

    case 'dropCollection': {
      await mongoDb.dropCollection(operation.collection);
      break;
    }

    case 'collMod': {
      const opts = operation.options as {
        validatorAction?: 'addProperty' | 'removeProperty' | 'modifyProperty';
        property?: string;
        schema?: Record<string, unknown>;
        required?: boolean;
      };

      const collInfo = await mongoDb.listCollections({ name: operation.collection }).toArray();

      if (collInfo.length === 0) {
        throw new Error(`Collection ${operation.collection} does not exist`);
      }

      interface JsonSchema {
        bsonType?: string;
        properties?: Record<string, unknown>;
        required?: string[];
      }
      const collOptions = collInfo[0] as { options?: { validator?: { $jsonSchema?: JsonSchema } } };
      const existingValidator = collOptions.options?.validator ?? {};
      const existingSchema: JsonSchema = existingValidator.$jsonSchema ?? {
        bsonType: 'object',
        properties: {},
        required: [],
      };

      if (opts.validatorAction === 'addProperty' && opts.property && opts.schema) {
        existingSchema.properties = existingSchema.properties || {};
        existingSchema.properties[opts.property] = opts.schema;
        if (opts.required) {
          existingSchema.required = existingSchema.required || [];
          if (!existingSchema.required.includes(opts.property)) {
            existingSchema.required.push(opts.property);
          }
        }
      } else if (opts.validatorAction === 'removeProperty' && opts.property) {
        if (existingSchema.properties) {
          delete existingSchema.properties[opts.property];
        }
        if (existingSchema.required) {
          existingSchema.required = existingSchema.required.filter(
            (r: string) => r !== opts.property
          );
        }
      } else if (opts.validatorAction === 'modifyProperty' && opts.property && opts.schema) {
        existingSchema.properties = existingSchema.properties || {};
        existingSchema.properties[opts.property] = opts.schema;
      }

      await mongoDb.command({
        collMod: operation.collection,
        validator: { $jsonSchema: existingSchema },
      });
      break;
    }

    case 'createIndex': {
      if (!operation.indexSpec) {
        throw new Error('Index specification required for createIndex operation');
      }
      const collection = mongoDb.collection(operation.collection);
      await collection.createIndex(operation.indexSpec.keys, operation.indexSpec.options);
      break;
    }

    case 'dropIndex': {
      const opts = operation.options as { indexName: string };
      const collection = mongoDb.collection(operation.collection);
      await collection.dropIndex(opts.indexName);
      break;
    }

    default:
      throw new Error(`Unsupported MongoDB migration operation: ${operation.operation}`);
  }
}
