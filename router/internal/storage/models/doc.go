// Package models holds the typed structs that mirror the SQL schema.
//
// Models are immutable value types that travel across the storage boundary.
// Pointers denote nullable columns; the zero value of each struct is a
// usable "absent" representation. JSON columns are carried as []byte so
// callers can decode them with encoding/json in their own context.
//
// The structs do not depend on a database driver; pgx/Bun adapters map SQL
// rows to these types at the repository boundary.
package models
