// Package middleware provides composable net/http security boundary handlers
// for the Cartethyia daemon. Each handler in this package has a focused
// contract: it inspects or mutates a single cross-cutting concern and delegates
// state lookup to a narrow interface so the runtime wiring can choose its
// own backing store.
//
// The handlers here intentionally avoid importing database, provider, or
// proxy code. They form a policy layer that the HTTP boundary composes onto
// individual routes.
package middleware
