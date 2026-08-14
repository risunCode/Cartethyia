package cache

import (
	"fmt"
	"strconv"
	"strings"
)

// Generation captures the catalog/credential/network generation tuple that
// participates in every cache key (R-CACHE-04). Any change to any component
// produces a new Generation; cache entries recorded under a previous
// Generation are treated as generation-mismatch misses.
//
// The four components are intentionally separate so callers can rebuild a
// Generation cheaply when only one component changes (for example, when a
// credential refresh bumps the credential counter while catalog/health are
// unchanged).
type Generation struct {
	// Catalog is the catalog snapshot generation. Bumped whenever models,
	// aliases, capabilities, or combinations change.
	Catalog uint64
	// Credentials is the credential generation. Bumped whenever a credential
	// rotate/refresh publishes a new snapshot.
	Credentials uint64
	// Health is the route-health generation. Bumped when recovery sweeps
	// publish a new health view.
	Health uint64
	// Network is the network policy generation. Bumped when egress policy
	// changes invalidate previously-routed entries.
	Network uint64
}

// ZeroGeneration is the zero value; IsZero reports true for it.
var ZeroGeneration = Generation{}

// IsZero reports whether the generation is the zero value.
func (g Generation) IsZero() bool {
	return g == ZeroGeneration
}

// wire produces the deterministic fingerprint component of the generation.
func (g Generation) wire() string {
	return fmt.Sprintf(
		"gen=c%04d/cr%04d/h%04d/n%04d",
		g.Catalog, g.Credentials, g.Health, g.Network,
	)
}

// String returns a stable, human-readable form used in error messages.
func (g Generation) String() string {
	return strings.Join([]string{
		"catalog=" + strconv.FormatUint(g.Catalog, 10),
		"credentials=" + strconv.FormatUint(g.Credentials, 10),
		"health=" + strconv.FormatUint(g.Health, 10),
		"network=" + strconv.FormatUint(g.Network, 10),
	}, "/")
}

// Equal reports whether two generations are identical.
func (g Generation) Equal(other Generation) bool {
	return g == other
}

// MatchesGeneration reports whether two generations are equal. It exists for
// parity with the documented contract (R-CACHE-04) and reads as a positive
// form at call sites.
func MatchesGeneration(a, b Generation) bool {
	return a == b
}
