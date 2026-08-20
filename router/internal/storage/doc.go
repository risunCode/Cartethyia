// Package db defines the PostgreSQL-facing storage boundary for Cartethyia.
//
// The package exposes four layers:
//
//   - Config       — PostgreSQL connection parameters parsed from a libpq URL.
//   - Models       — typed structs that mirror the SQL schema one-to-one.
//   - Migrations   — ordered DDL statements applied in deterministic order.
//   - Repositories — narrow interfaces for each storage concern (accounts,
//     api keys, proxies, settings, bans, telemetry, backup metadata,
//     health).
//
// The concrete PostgreSQL adapter is BunDatabase, backed by Bun's SQL-first
// ORM and pgdriver. Repository interfaces remain independent of the driver so
// tests and alternative composition environments can inject a narrow store.
// Nothing in this package copies SQLite code from the legacy TypeScript
// storage layer.
package db
