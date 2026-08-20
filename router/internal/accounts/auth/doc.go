// Package auth defines the provider-neutral upstream account credential
// lifecycle contract used by proxy, provider adapters, runtime, and admin
// layers.
//
// The package owns opaque credential references, redacted secret material,
// account metadata, OAuth/device-flow driver contracts, refresh coordination,
// and compare-and-swap token state. Client HTTP authentication remains owned by
// gateway/middleware; console API handlers only project the auth lifecycle into
// public admin responses.
//
// Provider-specific network clients are bounded behind AuthDriver. Raw
// credential material is carried by Secret, whose String, GoString, JSON, and
// text encoders are redacted.
package auth
