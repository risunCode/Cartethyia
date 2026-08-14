package providers

import (
	"fmt"
	"sort"
	"sync"
)

// Loader produces a Provider on demand. It is invoked the first time the
// registry resolves the registered id and the result is cached for the
// lifetime of the registry. Loaders are used to defer construction of
// adapters that pull in heavy dependencies.
//
// A Loader MUST be idempotent: Get may invoke it once and only once per id
// per registry lifetime, even when called concurrently. A Loader that
// returns a non-nil error has the error surfaced to the caller wrapped in
// a *LoaderError; the lazy entry is preserved so a retry can re-attempt
// materialization. A Loader that returns a nil Provider or a Provider with
// an empty metadata id is treated as a malformed materialization and is
// reported as a *LoaderError with a nil cause.
type Loader func() (Provider, error)

// LoaderFactory describes an adapter without instantiating it. Factories
// expose the provider id, display name, and declared surfaces to the
// registry before the underlying Provider is built, so the registry can be
// queried even when the adapter is only constructed on first use.
type LoaderFactory struct {
	// ID is the stable provider id; matches the id the constructed
	// Provider publishes.
	ID string
	// DisplayName is the human-readable label.
	DisplayName string
	// Surfaces is the set of Surfaces the adapter declares. The registry
	// uses this to short-circuit AdapterFor without invoking the loader.
	Surfaces []Surface
	// Load constructs the Provider.
	Load Loader
}

// Registry is the central provider discovery surface. A router that needs
// to send a request to a provider id queries the registry; the registry
// returns either the live Provider, an *UnknownProviderError for ids the
// registry has never seen, or a *LoaderError when a registered Loader
// fails to materialize.
//
// The registry is safe for concurrent use. The first lookup of a lazy
// provider invokes its Loader exactly once; subsequent lookups return the
// cached value, even when many goroutines race for the same id.
//
// Ordering is deterministic: IDs(), Surfaces(), and AdapterFor all iterate
// providers in ascending id order so callers and tests observe a stable
// sequence regardless of the order registrations happened.
type Registry struct {
	mu sync.RWMutex
	// eager is keyed by provider id; populated by Register and by the
	// first successful invocation of a lazy loader.
	eager map[string]Provider
	// lazy is keyed by provider id; populated by RegisterLazy. Cleared by
	// a successful Load or by a Register of the same id. A failed Load
	// preserves the entry so the caller may retry without re-registering.
	lazy map[string]LoaderFactory
	// loadLocks serializes the first-load for each id. It is keyed by id;
	// entries are created lazily and dropped after the load resolves so
	// the map stays bounded by the size of the registry.
	loadLocks map[string]*sync.Mutex
	// locksMu guards loadLocks itself. It is independent of mu so read
	// paths that never load (Has, IDs, Surfaces) do not contend with a
	// concurrent first-load.
	locksMu sync.Mutex
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry {
	return &Registry{
		eager:     make(map[string]Provider),
		lazy:      make(map[string]LoaderFactory),
		loadLocks: make(map[string]*sync.Mutex),
	}
}

// acquireLoadLock returns the per-id load mutex, creating it on first use.
func (r *Registry) acquireLoadLock(id string) *sync.Mutex {
	r.locksMu.Lock()
	defer r.locksMu.Unlock()
	if l, ok := r.loadLocks[id]; ok {
		return l
	}
	l := &sync.Mutex{}
	r.loadLocks[id] = l
	return l
}

// releaseLoadLock drops the per-id load mutex once the load completes.
// Removing the entry after a successful or failed load keeps the map
// bounded; the next first-load re-acquires a fresh mutex.
func (r *Registry) releaseLoadLock(id string) {
	r.locksMu.Lock()
	defer r.locksMu.Unlock()
	delete(r.loadLocks, id)
}

// Register stores provider in the registry under its declared id.
func (r *Registry) Register(provider Provider) error {
	if r == nil {
		return ErrRegistryUnavailable
	}
	if provider == nil {
		return fmt.Errorf("%w: provider is nil", ErrInvalidRegistration)
	}
	meta := provider.Metadata()
	if meta.ID == "" {
		return fmt.Errorf("%w: provider id is empty", ErrInvalidRegistration)
	}
	if provider.Models() == nil {
		return fmt.Errorf("%w: provider %q has no model catalog", ErrInvalidRegistration, meta.ID)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.eager[meta.ID] = provider
	delete(r.lazy, meta.ID)
	return nil
}

// RegisterLazy stores a factory that will be invoked the first time the id is
// resolved. Invalid factories are returned to the caller.
func (r *Registry) RegisterLazy(factory LoaderFactory) error {
	if r == nil {
		return ErrRegistryUnavailable
	}
	if factory.ID == "" || factory.Load == nil {
		return fmt.Errorf("%w: lazy factory requires id and loader", ErrInvalidRegistration)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.lazy[factory.ID] = factory
	return nil
}

// Unregister removes both eager and lazy entries for providerID. It returns
// true if anything was removed.
func (r *Registry) Unregister(providerID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	removed := false
	if _, ok := r.eager[providerID]; ok {
		delete(r.eager, providerID)
		removed = true
	}
	if _, ok := r.lazy[providerID]; ok {
		delete(r.lazy, providerID)
		removed = true
	}
	if removed {
		r.releaseLoadLock(providerID)
	}
	return removed
}

// Get resolves a provider by id, materializing lazy entries on first
// access. The return contract is:
//   - (*UnknownProviderError) when the id was never registered.
//   - (*LoaderError) when a registered Loader failed, returned a nil
//     provider, or returned a provider with an empty metadata id. The
//     underlying cause is preserved via errors.Unwrap so callers can
//     inspect it with errors.Is / errors.As.
//   - (Provider, nil) on success.
//
// Get is safe to call from multiple goroutines. The first successful or
// failed load for an id is observed by every concurrent caller; subsequent
// calls reuse the cached eager entry.
func (r *Registry) Get(providerID string) (Provider, error) {
	if r == nil {
		return nil, ErrRegistryUnavailable
	}
	if providerID == "" {
		return nil, &UnknownProviderError{ProviderID: providerID}
	}
	r.mu.RLock()
	if p, ok := r.eager[providerID]; ok {
		r.mu.RUnlock()
		return p, nil
	}
	factory, ok := r.lazy[providerID]
	r.mu.RUnlock()

	if !ok {
		return nil, &UnknownProviderError{ProviderID: providerID}
	}

	// Serialize the first-load for this id. A second goroutine arriving
	// while we are still loading will block on the per-id mutex and pick
	// up the eager entry the loader produced without invoking Load again.
	loadMu := r.acquireLoadLock(providerID)
	loadMu.Lock()
	defer loadMu.Unlock()

	r.mu.Lock()
	defer r.mu.Unlock()

	// Double-check: another goroutine may have completed the load while
	// we were waiting for the per-id mutex.
	if p, ok := r.eager[providerID]; ok {
		return p, nil
	}
	factory, ok = r.lazy[providerID]
	if !ok {
		// The lazy entry was unregistered while we were waiting.
		return nil, &UnknownProviderError{ProviderID: providerID}
	}

	provider, err := factory.Load()
	if err != nil {
		return nil, &LoaderError{ProviderID: providerID, Err: err}
	}
	if provider == nil || provider.Metadata().ID == "" {
		return nil, &LoaderError{ProviderID: providerID}
	}
	r.eager[providerID] = provider
	delete(r.lazy, providerID)
	return provider, nil
}

// Has reports whether the registry currently knows about providerID. A
// present lazy entry counts as known even if its Loader has not been
// invoked yet.
func (r *Registry) Has(providerID string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if _, ok := r.eager[providerID]; ok {
		return true
	}
	_, ok := r.lazy[providerID]
	return ok
}

// Size reports the number of registered providers, counting both eager and
// lazy entries. If a provider is registered both eagerly and lazily (a
// shadowed lazy factory), it is counted once via the lazy entry.
func (r *Registry) Size() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	seen := make(map[string]struct{}, len(r.eager)+len(r.lazy))
	for id := range r.eager {
		seen[id] = struct{}{}
	}
	for id := range r.lazy {
		seen[id] = struct{}{}
	}
	return len(seen)
}

// IDs returns the sorted set of registered provider ids. The slice is a
// fresh allocation safe for the caller to retain. The result is
// deterministic: ids are returned in ascending lexicographic order and the
// same set of registrations always produces the same output.
func (r *Registry) IDs() []string {
	r.mu.RLock()
	seen := make(map[string]struct{}, len(r.eager)+len(r.lazy))
	for id := range r.eager {
		seen[id] = struct{}{}
	}
	for id := range r.lazy {
		seen[id] = struct{}{}
	}
	r.mu.RUnlock()
	out := make([]string, 0, len(seen))
	for id := range seen {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// Surfaces returns the union of declared Surfaces across all eager
// providers. Lazy entries are NOT resolved: their declared surfaces are
// taken from the LoaderFactory at registration time so the registry can
// answer without forcing materialization.
//
// The result is sorted in ascending Surface order so callers can use it
// for deterministic dispatch tables.
func (r *Registry) Surfaces() []Surface {
	r.mu.RLock()
	seen := make(map[Surface]struct{})
	for _, p := range r.eager {
		for _, s := range p.Capabilities().Surfaces {
			seen[s] = struct{}{}
		}
	}
	for _, f := range r.lazy {
		for _, s := range f.Surfaces {
			seen[s] = struct{}{}
		}
	}
	r.mu.RUnlock()
	out := make([]Surface, 0, len(seen))
	for s := range seen {
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// AdapterFor returns the first provider whose catalog knows modelID or, if
// no catalog claim is found, the first provider declaring surface. This
// mirrors the legacy ProviderRegistry.adapterFor behaviour: prefer a
// catalog match, fall back to a surface match.
//
// The surface-fallback scan also covers lazy entries by consulting their
// LoaderFactory's declared Surfaces without materializing the adapter.
// A lazy factory whose declared Surfaces include the requested surface is
// materialized on demand through Get; this preserves the "lazy providers
// are not needlessly materialized" property for lookups that resolve via
// the catalog of an eager provider or that miss every provider.
//
// Iteration order is ascending provider id so the choice between two
// providers that both match is deterministic.
//
// Returns:
//   - (Provider, nil) when an eager catalog match, eager surface match, or
//     lazy surface match resolves to a provider.
//   - (*LoaderError) when the surface-fallback resolved to a lazy entry
//     whose Loader failed.
//   - (*UnknownModelError) when neither the catalog nor any declared
//     surface produced a match. The ProviderID field is left empty because
//     no single provider can be blamed for the miss.
func (r *Registry) AdapterFor(modelID string, surface Surface) (Provider, error) {
	if r == nil {
		return nil, ErrRegistryUnavailable
	}
	r.mu.RLock()
	eagerIDs := make([]string, 0, len(r.eager))
	for id := range r.eager {
		eagerIDs = append(eagerIDs, id)
	}
	sort.Strings(eagerIDs)
	r.mu.RUnlock()

	// Catalog-claim pass: an eager provider whose Models() exposes modelID
	// is preferred regardless of surface order.
	for _, id := range eagerIDs {
		r.mu.RLock()
		p := r.eager[id]
		r.mu.RUnlock()
		if m := p.Models().Get(modelID); m != nil {
			return p, nil
		}
	}

	// Eager surface-fallback pass: an eager provider that declares the
	// surface wins before we touch any lazy adapter.
	for _, id := range eagerIDs {
		r.mu.RLock()
		p := r.eager[id]
		r.mu.RUnlock()
		if HasCapability(p.Capabilities(), surface) {
			return p, nil
		}
	}

	// Lazy surface-fallback pass: consult the factory Surfaces without
	// materializing. The first lazy factory whose declared surfaces include
	// the requested surface is materialized on demand.
	r.mu.RLock()
	lazyIDs := make([]string, 0, len(r.lazy))
	for id := range r.lazy {
		lazyIDs = append(lazyIDs, id)
	}
	sort.Strings(lazyIDs)
	lazyFactories := make([]LoaderFactory, 0, len(lazyIDs))
	for _, id := range lazyIDs {
		lazyFactories = append(lazyFactories, r.lazy[id])
	}
	r.mu.RUnlock()

	for _, f := range lazyFactories {
		for _, s := range f.Surfaces {
			if s == surface {
				return r.Get(f.ID)
			}
		}
	}
	return nil, &UnknownModelError{ProviderID: "", ModelID: modelID}
}
