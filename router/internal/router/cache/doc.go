// Package cache owns the Cartethyia resolution cache contract.
//
// The daemon exposes one cache contract; this slice provides the always-present
// L0 in-memory backend described by R-CACHE-01. An optional L1 Redis backend
// is wired separately and shares the same Cache interface so callers never
// depend on a Redis client directly (R-CACHE-01, design §8.3).
//
// Provider prompt-cache semantics live in internal/providers and never flow
// through this package (R-CACHE-06).
package cache
