import type { SchemaDefinition } from './index.js';

export interface HooksGeneratorOptions {
  includeQueryHooks?: boolean;
  includeMutationHooks?: boolean;
  typesImportPath?: string;
}

function pascalCase(str: string): string {
  return str
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('');
}

function singularize(word: string): string {
  if (word.endsWith('ies')) {
    return `${word.slice(0, -3)}y`;
  }
  if (
    word.endsWith('ses') ||
    word.endsWith('xes') ||
    word.endsWith('zes') ||
    word.endsWith('ches') ||
    word.endsWith('shes')
  ) {
    return word.slice(0, -2);
  }
  if (word.endsWith('s') && !word.endsWith('ss')) {
    return word.slice(0, -1);
  }
  return word;
}

function getHookNames(tableName: string): {
  pluralName: string;
  singularName: string;
  listHook: string;
  singleHook: string;
  createHook: string;
  updateHook: string;
  deleteHook: string;
} {
  const pluralPascal = pascalCase(tableName);
  const singularPascal = pascalCase(singularize(tableName));

  return {
    pluralName: pluralPascal,
    singularName: singularPascal,
    listHook: `use${pluralPascal}`,
    singleHook: `use${singularPascal}`,
    createHook: `useCreate${singularPascal}`,
    updateHook: `useUpdate${singularPascal}`,
    deleteHook: `useDelete${singularPascal}`,
  };
}

function generateTableHooks(
  tableName: string,
  typeName: string,
  options: HooksGeneratorOptions
): string[] {
  const lines: string[] = [];
  const hooks = getHookNames(tableName);
  const { includeQueryHooks = true, includeMutationHooks = true } = options;

  lines.push(`// ==================== ${hooks.pluralName} ====================`);
  lines.push('');

  if (includeQueryHooks) {
    lines.push(`/** Query hook for fetching all ${tableName} */`);
    lines.push(
      `export function ${hooks.listHook}(options?: Omit<UseQueryOptions<${typeName}>, 'table'>) {`
    );
    lines.push(`  return useQuery<${typeName}>({ ...options, table: '${tableName}' });`);
    lines.push('}');
    lines.push('');

    lines.push(`/** Query hook for fetching a single ${singularize(tableName)} by ID */`);
    lines.push(
      `export function ${hooks.singleHook}(id: string, options?: Omit<UseQueryOptions<${typeName}>, 'table' | 'where'>) {`
    );
    lines.push(
      `  return useQueryOne<${typeName}>({ ...options, table: '${tableName}', where: { id: { eq: id } } });`
    );
    lines.push('}');
    lines.push('');
  }

  if (includeMutationHooks) {
    lines.push(`/** Mutation hook for creating a ${singularize(tableName)} */`);
    lines.push(
      `export function ${hooks.createHook}(options?: UseMutationOptions<${typeName} | ${typeName}[], InsertVariables<${typeName}>>) {`
    );
    lines.push(`  const mutation = useInsert<${typeName}>(options);`);
    lines.push('  return {');
    lines.push('    ...mutation,');
    lines.push(
      `    mutate: (data: InsertVariables<${typeName}>['data']) => mutation.mutate({ table: '${tableName}', data }),`
    );
    lines.push(
      `    mutateAsync: (data: InsertVariables<${typeName}>['data']) => mutation.mutateAsync({ table: '${tableName}', data }),`
    );
    lines.push('  };');
    lines.push('}');
    lines.push('');

    lines.push(`/** Mutation hook for updating a ${singularize(tableName)} */`);
    lines.push(
      `export function ${hooks.updateHook}(options?: UseMutationOptions<${typeName}[], UpdateVariables<${typeName}>>) {`
    );
    lines.push(`  const mutation = useUpdate<${typeName}>(options);`);
    lines.push('  return {');
    lines.push('    ...mutation,');
    lines.push(
      `    mutate: (args: { where: UpdateVariables<${typeName}>['where']; data: UpdateVariables<${typeName}>['data'] }) =>`
    );
    lines.push(`      mutation.mutate({ table: '${tableName}', ...args }),`);
    lines.push(
      `    mutateAsync: (args: { where: UpdateVariables<${typeName}>['where']; data: UpdateVariables<${typeName}>['data'] }) =>`
    );
    lines.push(`      mutation.mutateAsync({ table: '${tableName}', ...args }),`);
    lines.push('  };');
    lines.push('}');
    lines.push('');

    lines.push(`/** Mutation hook for deleting a ${singularize(tableName)} */`);
    lines.push(
      `export function ${hooks.deleteHook}(options?: UseMutationOptions<{ deleted: number }, DeleteVariables<${typeName}>>) {`
    );
    lines.push(`  const mutation = useDelete<${typeName}>(options);`);
    lines.push('  return {');
    lines.push('    ...mutation,');
    lines.push(
      `    mutate: (where: DeleteVariables<${typeName}>['where']) => mutation.mutate({ table: '${tableName}', where }),`
    );
    lines.push(
      `    mutateAsync: (where: DeleteVariables<${typeName}>['where']) => mutation.mutateAsync({ table: '${tableName}', where }),`
    );
    lines.push('  };');
    lines.push('}');
    lines.push('');
  }

  return lines;
}

export function generateHooks(
  schemas: Map<string, SchemaDefinition>,
  options: HooksGeneratorOptions = {}
): string {
  const {
    typesImportPath = './types',
    includeQueryHooks = true,
    includeMutationHooks = true,
  } = options;

  const lines: string[] = [
    '// Auto-generated by @launchpad/db-engine',
    '// Do not edit this file manually',
    '',
  ];

  if (includeQueryHooks) {
    lines.push("import { useQuery, useQueryOne } from '@launchpad/db/react';");
    lines.push("import type { UseQueryOptions } from '@launchpad/db/react';");
  }

  if (includeMutationHooks) {
    lines.push("import { useInsert, useUpdate, useDelete } from '@launchpad/db/react';");
    lines.push(
      "import type { UseMutationOptions, InsertVariables, UpdateVariables, DeleteVariables } from '@launchpad/db/react';"
    );
  }

  const typeImports: string[] = [];
  for (const [schemaName, schema] of schemas) {
    const namespace = pascalCase(schemaName);
    for (const tableName of Object.keys(schema.tables)) {
      const typeName = pascalCase(tableName);
      typeImports.push(`${namespace}.${typeName}`);
      if (includeMutationHooks) {
        typeImports.push(`${namespace}.${typeName}Insert`);
        typeImports.push(`${namespace}.${typeName}Update`);
      }
    }
  }

  if (typeImports.length > 0) {
    const namespaces = new Set<string>();
    for (const [schemaName] of schemas) {
      namespaces.add(pascalCase(schemaName));
    }
    lines.push(`import type { ${Array.from(namespaces).join(', ')} } from '${typesImportPath}';`);
  }

  lines.push('');

  for (const [schemaName, schema] of schemas) {
    const namespace = pascalCase(schemaName);

    for (const tableName of Object.keys(schema.tables)) {
      const typeName = `${namespace}.${pascalCase(tableName)}`;
      const tableHooks = generateTableHooks(tableName, typeName, {
        includeQueryHooks,
        includeMutationHooks,
        typesImportPath,
      });
      lines.push(...tableHooks);
    }
  }

  return lines.join('\n');
}
