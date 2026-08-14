// Package repositories declares the storage interfaces consumed by
// admin/proxy/auth packages. Concrete implementations (pgx, Bun, sqlx,
// in-memory tests) live outside this package; the daemon runtime wires
// them into a Bundle that other internal packages accept.
//
// Every method takes a context.Context as its first argument. Returned
// errors are driver-level; callers that need migration context wrap them
// at the composition root.
package repositories
