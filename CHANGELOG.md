# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2025-12-17

### Added
- Multi-database support: PostgreSQL, MySQL, SQLite
- Built-in multi-tenancy with automatic `app_id` and `organization_id` injection
- Query builder with fluent API for SELECT, INSERT, UPDATE, DELETE
- SQL compiler with dialect-specific adapters
- Custom migration system with up/down scripts and checksum verification
- Dynamic schema registry for runtime table registration
- Type generation CLI for TypeScript interfaces
- ORM decorators: @Entity, @Column, @PrimaryKey, @TenantColumn, @Unique, @Nullable, @Default, @Index
- ORM relations: @OneToMany, @ManyToOne, @OneToOne, @ManyToMany
- Base entity classes: TenantEntity, TimestampedEntity, TenantTimestampedEntity
- Repository pattern with find, findOne, create, update, delete operations
- Module system for organizing migrations by feature (ModuleRegistry, MigrationCollector)
- Schema extraction utilities for generating schemas from entity classes
- Transaction support with tenant context
- 191 tests (173 unit + 18 integration)

### Documentation
- Comprehensive README with quick start guide
- INTEGRATION.md with detailed usage examples
- Multi-tenancy setup guide
- Query builder reference
- Migration authoring guide
- ORM entities documentation
- Module system documentation
- Type generation guide
- Troubleshooting section

[0.1.0]: https://github.com/AudioGenius-ai/launchpad-db-engine/releases/tag/v0.1.0
