// Package accounts defines the provider-neutral upstream account credential
// lifecycle contract used by proxy, provider adapters, runtime, and admin
// layers.
//
// The package owns opaque credential references, redacted secret material,
// account metadata, OAuth/device-flow driver contracts, refresh coordination,
// and compare-and-swap token state. Client HTTP authentication remains owned by
// server/middleware; admin sessions remain owned by server/admin.
//
// Provider-specific network clients are injected through AuthDriver and are
// never constructed inside this package. Raw credential material is carried by
// Secret, whose String, GoString, JSON, and text encoders are redacted.
package accounts
