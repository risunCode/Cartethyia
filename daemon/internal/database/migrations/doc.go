// Package migrations holds the ordered DDL statements that initialize a
// Cartethyia PostgreSQL database.
//
// Migrations are versioned integers starting at 1 and applied in the order
// returned by All(). Tables that other tables reference appear first, so a
// fresh database applies them without foreign-key violations. The package
// is pure data: it does not connect to a database or import a driver; the
// runtime applies the statements via the Driver interface.
package migrations
