interface CliConfig {
    databaseUrl: string;
    migrationsPath: string;
    typesOutputPath?: string;
}
declare function runMigrations(config: CliConfig, options: {
    scope?: 'core' | 'template';
    templateKey?: string;
    steps?: number;
    toVersion?: number;
    dryRun?: boolean;
    direction: 'up' | 'down';
}): Promise<void>;
declare function getMigrationStatus(config: CliConfig, options: {
    scope?: 'core' | 'template';
    templateKey?: string;
}): Promise<void>;
declare function verifyMigrations(config: CliConfig, options: {
    scope?: 'core' | 'template';
    templateKey?: string;
}): Promise<void>;
declare function createMigration(config: CliConfig, options: {
    name: string;
    scope: 'core' | 'template';
    templateKey?: string;
}): Promise<void>;
declare function generateTypesFromRegistry(config: CliConfig, options: {
    appId?: string;
    outputPath?: string;
}): Promise<void>;
declare function registerSchema(config: CliConfig, options: {
    appId: string;
    schemaName: string;
    version: string;
    schemaPath: string;
}): Promise<void>;
declare function listModules(config: CliConfig): Promise<void>;
declare function registerModule(config: CliConfig, options: {
    name: string;
    displayName: string;
    version: string;
    migrationPrefix: string;
    description?: string;
    dependencies?: string[];
}): Promise<void>;
declare function runModuleMigrations(config: CliConfig, options: {
    modulesPath: string;
    dryRun?: boolean;
    direction?: 'up' | 'down';
    steps?: number;
}): Promise<void>;

export { type CliConfig, createMigration, generateTypesFromRegistry, getMigrationStatus, listModules, registerModule, registerSchema, runMigrations, runModuleMigrations, verifyMigrations };
