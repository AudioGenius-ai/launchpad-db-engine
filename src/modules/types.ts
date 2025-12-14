export interface ModuleDefinition {
  name: string;
  displayName: string;
  description?: string;
  version: string;
  dependencies?: string[];
  migrationPrefix: string;
}

export interface ModuleMigrationSource {
  moduleName: string;
  migrationsPath: string;
}
