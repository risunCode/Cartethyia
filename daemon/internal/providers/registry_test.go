package providers

import (
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
)

// stubProvider is a minimal Provider implementation for registry tests.
// It is intentionally not used outside the registry test file; the
// production adapters are exercised by their own packages.
type stubProvider struct {
	id        string
	display   string
	protocol  Protocol
	surfaces  []Surface
	models    []ProviderModel
	callsLoad int32
}

func (s *stubProvider) Metadata() ProviderMeta {
	return ProviderMeta{
		ID:              s.id,
		DisplayName:     s.display,
		Protocol:        s.protocol,
		CredentialKind:  CredentialAPIKey,
		CredentialKinds: []CredentialKind{CredentialAPIKey},
	}
}

func (s *stubProvider) Capabilities() ProviderCaps {
	return ProviderCaps{Surfaces: s.surfaces, Streaming: true}
}

func (s *stubProvider) Models() ProviderModelCatalog {
	return newStaticCatalog(s.models)
}

func (s *stubProvider) ResolveTarget(modelID string, surface Surface) (RouteTarget, error) {
	if m := s.Models().Get(modelID); m == nil {
		return RouteTarget{}, &UnknownModelError{ProviderID: s.id, ModelID: modelID}
	}
	return RouteTarget{ProviderID: s.id, ModelID: modelID, UpstreamModelID: modelID, Surface: surface}, nil
}

func (s *stubProvider) Endpoint(target RouteTarget) Endpoint {
	return Endpoint{Method: "POST", Path: "v1/chat"}
}

func (s *stubProvider) AuthMaterial(credential string, target RouteTarget) (AuthMaterial, error) {
	return AuthMaterial{Headers: map[string][]string{"Authorization": {"Bearer " + credential}}}, nil
}

func (s *stubProvider) BuildRequest(envelope RequestEnvelope, credential string) (BuiltRequest, error) {
	return BuiltRequest{Endpoint: Endpoint{Method: "POST", Path: "v1/chat"}}, nil
}

func (s *stubProvider) ClassifyResponse(evidence ResponseEvidence) ClassifiedResponse {
	return classifyByStatus(evidence)
}

// newStub is a convenience constructor for tests.
func newStub(id string, surfaces []Surface, models []ProviderModel) *stubProvider {
	return &stubProvider{
		id:       id,
		display:  id,
		protocol: ProtocolOpenAI,
		surfaces: surfaces,
		models:   models,
	}
}

func TestRegistryRegisterAndGet(t *testing.T) {
	r := NewRegistry()
	want := newStub("openai", []Surface{SurfaceOpenAIChat}, []ProviderModel{
		Model("gpt-4o", "GPT-4o", nil),
	})
	r.Register(want)

	got, err := r.Get("openai")
	if err != nil {
		t.Fatalf("Get(openai) = %v, want nil", err)
	}
	if got != want {
		t.Fatalf("Get(openai) returned a different instance; eager entries must not be re-cloned")
	}
}

func TestRegistryUnknownProviderReturnsTypedError(t *testing.T) {
	r := NewRegistry()
	_, err := r.Get("does-not-exist")
	var unk *UnknownProviderError
	if !errors.As(err, &unk) {
		t.Fatalf("Get(unknown) = %v (%T), want *UnknownProviderError", err, err)
	}
	if unk.ProviderID != "does-not-exist" {
		t.Fatalf("UnknownProviderError.ProviderID = %q, want %q", unk.ProviderID, "does-not-exist")
	}
}

func TestRegistryGetEmptyID(t *testing.T) {
	r := NewRegistry()
	_, err := r.Get("")
	var unk *UnknownProviderError
	if !errors.As(err, &unk) {
		t.Fatalf("Get(\"\") = %v (%T), want *UnknownProviderError", err, err)
	}
}

func TestRegistryRegisterNilAndEmptyIDIsDropped(t *testing.T) {
	r := NewRegistry()
	r.Register(nil)
	empty := newStub("", nil, nil)
	r.Register(empty)
	if got := r.Size(); got != 0 {
		t.Fatalf("Size after nil/empty register = %d, want 0", got)
	}
}

func TestRegistryRegisterLazyNilFactoryIsDropped(t *testing.T) {
	r := NewRegistry()
	r.RegisterLazy(LoaderFactory{ID: ""})
	r.RegisterLazy(LoaderFactory{ID: "missing-loader", Load: nil})
	if got := r.Size(); got != 0 {
		t.Fatalf("Size after invalid lazy register = %d, want 0", got)
	}
}

func TestRegistryRegisterReplacesPrevious(t *testing.T) {
	r := NewRegistry()
	first := newStub("openai", []Surface{SurfaceOpenAIChat}, nil)
	second := newStub("openai", []Surface{SurfaceOpenAIResponses}, nil)
	r.Register(first)
	r.Register(second)
	got, err := r.Get("openai")
	if err != nil {
		t.Fatalf("Get(openai) = %v, want nil", err)
	}
	if got != second {
		t.Fatalf("Register did not replace the previous entry")
	}
	if got := r.Size(); got != 1 {
		t.Fatalf("Size after replace = %d, want 1", got)
	}
}

func TestRegistryRegisterClearsLazyEntry(t *testing.T) {
	r := NewRegistry()
	invocations := atomic.Int32{}
	factory := LoaderFactory{
		ID:          "lazy",
		DisplayName: "lazy",
		Surfaces:    []Surface{SurfaceOpenAIChat},
		Load: func() (Provider, error) {
			invocations.Add(1)
			return newStub("lazy", []Surface{SurfaceOpenAIChat}, nil), nil
		},
	}
	r.RegisterLazy(factory)
	eager := newStub("lazy", []Surface{SurfaceOpenAIChat}, nil)
	r.Register(eager)
	if !r.Has("lazy") {
		t.Fatalf("Has(lazy) = false, want true after eager Register of a lazy id")
	}
	got, err := r.Get("lazy")
	if err != nil {
		t.Fatalf("Get(lazy) = %v, want nil", err)
	}
	if got != eager {
		t.Fatalf("Get returned the lazy result; eager Register should have replaced it")
	}
	if invocations.Load() != 0 {
		t.Fatalf("Load was invoked %d times, want 0 (eager Register should clear the lazy entry)", invocations.Load())
	}
	if got := r.Size(); got != 1 {
		t.Fatalf("Size after eager replace = %d, want 1", got)
	}
}

func TestRegistryRegisterLazyAfterEagerIsPreserved(t *testing.T) {
	r := NewRegistry()
	eager := newStub("lazy", []Surface{SurfaceOpenAIChat}, nil)
	r.Register(eager)
	r.RegisterLazy(LoaderFactory{
		ID:       "lazy",
		Load:     func() (Provider, error) { return nil, errors.New("should not be called") },
		Surfaces: []Surface{SurfaceOpenAIChat},
	})
	got, err := r.Get("lazy")
	if err != nil {
		t.Fatalf("Get(lazy) = %v, want nil", err)
	}
	if got != eager {
		t.Fatalf("RegisterLazy after eager Register should not shadow the eager entry")
	}
	if got := r.Size(); got != 1 {
		t.Fatalf("Size = %d, want 1", got)
	}
}

func TestRegistryIDsSortedDeterministic(t *testing.T) {
	r := NewRegistry()
	// Insert in a non-sorted order to prove IDs() does not depend on map
	// iteration order.
	r.Register(newStub("zeta", nil, nil))
	r.Register(newStub("alpha", nil, nil))
	r.Register(newStub("mu", nil, nil))
	got := r.IDs()
	want := []string{"alpha", "mu", "zeta"}
	if len(got) != len(want) {
		t.Fatalf("IDs length = %d, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("IDs()[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestRegistryIDsDeduplicatesEagerAndLazy(t *testing.T) {
	r := NewRegistry()
	r.Register(newStub("openai", nil, nil))
	r.RegisterLazy(LoaderFactory{
		ID:   "openai",
		Load: func() (Provider, error) { return newStub("openai", nil, nil), nil },
	})
	got := r.IDs()
	if len(got) != 1 || got[0] != "openai" {
		t.Fatalf("IDs after eager+lazy same id = %v, want [openai]", got)
	}
}

func TestRegistrySurfacesSortedUnion(t *testing.T) {
	r := NewRegistry()
	r.Register(newStub("openai", []Surface{SurfaceOpenAIResponses, SurfaceImages}, nil))
	r.Register(newStub("anthropic", []Surface{SurfaceAnthropicMessages}, nil))
	r.RegisterLazy(LoaderFactory{
		ID:       "lazy",
		Surfaces: []Surface{SurfaceWebSearch, SurfaceImages},
		Load:     func() (Provider, error) { return newStub("lazy", nil, nil), nil },
	})
	got := r.Surfaces()
	want := []Surface{SurfaceAnthropicMessages, SurfaceImages, SurfaceOpenAIResponses, SurfaceWebSearch}
	if len(got) != len(want) {
		t.Fatalf("Surfaces length = %d, want %d (%v)", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("Surfaces()[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestRegistrySurfacesDoesNotMaterializeLazy(t *testing.T) {
	r := NewRegistry()
	materialized := atomic.Bool{}
	r.RegisterLazy(LoaderFactory{
		ID:       "lazy",
		Surfaces: []Surface{SurfaceOpenAIChat},
		Load: func() (Provider, error) {
			materialized.Store(true)
			return newStub("lazy", []Surface{SurfaceOpenAIChat}, nil), nil
		},
	})
	_ = r.Surfaces()
	if materialized.Load() {
		t.Fatalf("Surfaces() materialized a lazy entry; declared surfaces must be read from the factory only")
	}
}

func TestRegistryHasCountsLazy(t *testing.T) {
	r := NewRegistry()
	if r.Has("absent") {
		t.Fatalf("Has(absent) = true, want false on empty registry")
	}
	r.RegisterLazy(LoaderFactory{
		ID:   "lazy",
		Load: func() (Provider, error) { return newStub("lazy", nil, nil), nil },
	})
	if !r.Has("lazy") {
		t.Fatalf("Has(lazy) = false, want true before materialization")
	}
}

func TestRegistryUnregister(t *testing.T) {
	r := NewRegistry()
	r.Register(newStub("openai", nil, nil))
	r.RegisterLazy(LoaderFactory{
		ID:   "lazy",
		Load: func() (Provider, error) { return newStub("lazy", nil, nil), nil },
	})
	if !r.Unregister("openai") {
		t.Fatalf("Unregister(openai) = false, want true")
	}
	if !r.Unregister("lazy") {
		t.Fatalf("Unregister(lazy) = false, want true")
	}
	if r.Unregister("absent") {
		t.Fatalf("Unregister(absent) = true, want false")
	}
	if got := r.Size(); got != 0 {
		t.Fatalf("Size after unregister = %d, want 0", got)
	}
}

func TestRegistryLoaderErrorIsPreserved(t *testing.T) {
	r := NewRegistry()
	cause := errors.New("boom")
	r.RegisterLazy(LoaderFactory{
		ID:   "broken",
		Load: func() (Provider, error) { return nil, cause },
	})
	_, err := r.Get("broken")
	var lerr *LoaderError
	if !errors.As(err, &lerr) {
		t.Fatalf("Get(broken) = %v (%T), want *LoaderError", err, err)
	}
	if !errors.Is(err, cause) {
		t.Fatalf("errors.Is(err, cause) = false; LoaderError.Unwrap should expose the cause")
	}
	if lerr.ProviderID != "broken" {
		t.Fatalf("LoaderError.ProviderID = %q, want %q", lerr.ProviderID, "broken")
	}
}

func TestRegistryLoaderMalformedProviderIsLoaderError(t *testing.T) {
	r := NewRegistry()
	r.RegisterLazy(LoaderFactory{
		ID:   "nil-provider",
		Load: func() (Provider, error) { return nil, nil },
	})
	_, err := r.Get("nil-provider")
	var lerr *LoaderError
	if !errors.As(err, &lerr) {
		t.Fatalf("Get(nil-provider) = %v (%T), want *LoaderError", err, err)
	}
	if lerr.Err != nil {
		t.Fatalf("LoaderError.Err = %v, want nil for malformed provider", lerr.Err)
	}

	r2 := NewRegistry()
	r2.RegisterLazy(LoaderFactory{
		ID:   "empty-id",
		Load: func() (Provider, error) { return newStub("", nil, nil), nil },
	})
	_, err = r2.Get("empty-id")
	if !errors.As(err, &lerr) {
		t.Fatalf("Get(empty-id) = %v (%T), want *LoaderError", err, err)
	}
}

func TestRegistryLazyEntryPreservedAfterLoaderError(t *testing.T) {
	r := NewRegistry()
	attempts := atomic.Int32{}
	r.RegisterLazy(LoaderFactory{
		ID:   "broken",
		Load: func() (Provider, error) { attempts.Add(1); return nil, errors.New("nope") },
	})
	if _, err := r.Get("broken"); err == nil {
		t.Fatalf("Get(broken) = nil, want error")
	}
	if !r.Has("broken") {
		t.Fatalf("Has(broken) = false after failed load; caller should be able to retry")
	}
	if _, err := r.Get("broken"); err == nil {
		t.Fatalf("Get(broken) second attempt = nil, want error")
	}
	if got := attempts.Load(); got != 2 {
		t.Fatalf("Loader invocations = %d, want 2 (one per retry, no caching of failures)", got)
	}
}

func TestRegistryConcurrentFirstLoadMaterializesOnce(t *testing.T) {
	const goroutines = 64
	r := NewRegistry()
	invocations := atomic.Int32{}
	r.RegisterLazy(LoaderFactory{
		ID: "lazy",
		Load: func() (Provider, error) {
			invocations.Add(1)
			return newStub("lazy", []Surface{SurfaceOpenAIChat}, nil), nil
		},
	})

	start := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(goroutines)
	for i := 0; i < goroutines; i++ {
		go func() {
			defer wg.Done()
			<-start
			if _, err := r.Get("lazy"); err != nil {
				t.Errorf("Get(lazy) = %v, want nil", err)
			}
		}()
	}
	close(start)
	wg.Wait()

	if got := invocations.Load(); got != 1 {
		t.Fatalf("Loader invocations under concurrent Get = %d, want exactly 1", got)
	}
}

func TestRegistryConcurrentReadDuringFirstLoad(t *testing.T) {
	// Many readers racing with a single writer performing the first load
	// must all observe the registered id either as eager or lazy, and
	// none may see a torn state.
	const readers = 32
	r := NewRegistry()
	r.RegisterLazy(LoaderFactory{
		ID:   "lazy",
		Load: func() (Provider, error) { return newStub("lazy", nil, nil), nil },
	})

	var wg sync.WaitGroup
	wg.Add(readers)
	for i := 0; i < readers; i++ {
		go func() {
			defer wg.Done()
			if !r.Has("lazy") {
				t.Errorf("Has(lazy) = false during concurrent first load")
			}
		}()
	}
	if _, err := r.Get("lazy"); err != nil {
		t.Fatalf("Get(lazy) = %v, want nil", err)
	}
	wg.Wait()
}

func TestRegistryAdapterForCatalogHit(t *testing.T) {
	r := NewRegistry()
	want := newStub("openai", []Surface{SurfaceOpenAIChat}, []ProviderModel{
		Model("gpt-4o", "GPT-4o", nil),
	})
	r.Register(want)
	r.Register(newStub("anthropic", []Surface{SurfaceAnthropicMessages}, []ProviderModel{
		Model("claude-opus-4-1", "Claude Opus 4.1", nil),
	}))
	got, err := r.AdapterFor("gpt-4o", SurfaceOpenAIChat)
	if err != nil {
		t.Fatalf("AdapterFor = %v, want nil", err)
	}
	if got != want {
		t.Fatalf("AdapterFor did not return the catalog-matching provider")
	}
}

func TestRegistryAdapterForSurfaceFallback(t *testing.T) {
	r := NewRegistry()
	want := newStub("anthropic", []Surface{SurfaceAnthropicMessages}, []ProviderModel{
		Model("claude-opus-4-1", "Claude Opus 4.1", nil),
	})
	r.Register(newStub("openai", []Surface{SurfaceOpenAIChat}, []ProviderModel{
		Model("gpt-4o", "GPT-4o", nil),
	}))
	r.Register(want)
	got, err := r.AdapterFor("claude-sonnet-unknown", SurfaceAnthropicMessages)
	if err != nil {
		t.Fatalf("AdapterFor = %v, want nil", err)
	}
	if got != want {
		t.Fatalf("AdapterFor surface fallback returned the wrong provider")
	}
}

func TestRegistryAdapterForLazyMaterialization(t *testing.T) {
	r := NewRegistry()
	materialized := atomic.Bool{}
	r.RegisterLazy(LoaderFactory{
		ID:       "openrouter",
		Surfaces: []Surface{SurfaceOpenAIChat},
		Load: func() (Provider, error) {
			materialized.Store(true)
			return newStub("openrouter", []Surface{SurfaceOpenAIChat}, []ProviderModel{
				Model("qwen-coder", "Qwen Coder", nil),
			}), nil
		},
	})

	// Surface match against the lazy entry must materialize exactly once.
	got, err := r.AdapterFor("any-unknown-model", SurfaceOpenAIChat)
	if err != nil {
		t.Fatalf("AdapterFor lazy surface = %v, want nil", err)
	}
	if got.Metadata().ID != "openrouter" {
		t.Fatalf("AdapterFor lazy materialization picked %q, want openrouter", got.Metadata().ID)
	}
	if !materialized.Load() {
		t.Fatalf("AdapterFor did not materialize the lazy entry")
	}

	r.Register(newStub("openai", []Surface{SurfaceOpenAIChat}, []ProviderModel{
		Model("gpt-4o", "GPT-4o", nil),
	}))
	// be preferred; the lazy entry is now eager but the catalog should win.
	hit, err := r.AdapterFor("gpt-4o", SurfaceOpenAIChat)
	if err != nil {
		t.Fatalf("AdapterFor catalog hit after lazy = %v, want nil", err)
	}
	if hit.Metadata().ID != "openai" {
		t.Fatalf("catalog hit picked %q, want openai", hit.Metadata().ID)
	}
}

func TestRegistryAdapterForCatalogHitSkipsLazy(t *testing.T) {
	// A catalog match on an eager provider must not invoke a lazy loader.
	r := NewRegistry()
	r.Register(newStub("openai", []Surface{SurfaceOpenAIChat}, []ProviderModel{
		Model("gpt-4o", "GPT-4o", nil),
	}))
	materialized := atomic.Bool{}
	r.RegisterLazy(LoaderFactory{
		ID:       "openrouter",
		Surfaces: []Surface{SurfaceOpenAIChat},
		Load: func() (Provider, error) {
			materialized.Store(true)
			return newStub("openrouter", nil, nil), nil
		},
	})
	if _, err := r.AdapterFor("gpt-4o", SurfaceOpenAIChat); err != nil {
		t.Fatalf("AdapterFor = %v, want nil", err)
	}
	if materialized.Load() {
		t.Fatalf("AdapterFor catalog match materialized a lazy entry; should be unnecessary")
	}
}

func TestRegistryAdapterForUnknownModelUnknownSurface(t *testing.T) {
	r := NewRegistry()
	r.Register(newStub("openai", []Surface{SurfaceOpenAIChat}, []ProviderModel{
		Model("gpt-4o", "GPT-4o", nil),
	}))
	_, err := r.AdapterFor("does-not-exist", SurfaceWebSearch)
	var um *UnknownModelError
	if !errors.As(err, &um) {
		t.Fatalf("AdapterFor = %v (%T), want *UnknownModelError", err, err)
	}
	if um.ModelID != "does-not-exist" {
		t.Fatalf("UnknownModelError.ModelID = %q, want %q", um.ModelID, "does-not-exist")
	}
}

func TestRegistryAdapterForDeterministicAcrossTwoMatches(t *testing.T) {
	// Two eager providers both declare the same surface; the lower id
	// must win because iteration is sorted ascending.
	r := NewRegistry()
	r.Register(newStub("zulu", []Surface{SurfaceOpenAIChat}, nil))
	r.Register(newStub("alpha", []Surface{SurfaceOpenAIChat}, nil))
	got, err := r.AdapterFor("no-such-model", SurfaceOpenAIChat)
	if err != nil {
		t.Fatalf("AdapterFor = %v, want nil", err)
	}
	if got.Metadata().ID != "alpha" {
		t.Fatalf("AdapterFor picked %q, want alpha (lowest id)", got.Metadata().ID)
	}
}

func TestRegistryAdapterForLazyLoaderErrorIsSurfaced(t *testing.T) {
	r := NewRegistry()
	r.RegisterLazy(LoaderFactory{
		ID:       "broken",
		Surfaces: []Surface{SurfaceOpenAIChat},
		Load:     func() (Provider, error) { return nil, errors.New("boom") },
	})
	_, err := r.AdapterFor("nope", SurfaceOpenAIChat)
	var lerr *LoaderError
	if !errors.As(err, &lerr) {
		t.Fatalf("AdapterFor lazy loader error = %v (%T), want *LoaderError", err, err)
	}
	if lerr.ProviderID != "broken" {
		t.Fatalf("LoaderError.ProviderID = %q, want broken", lerr.ProviderID)
	}
}

func TestRegistryConcurrentGetAndRegister(t *testing.T) {
	// Race the registry: many goroutines call Get/Has/IDs/Register on
	// disjoint ids and on a small set of shared ids. Run with `go test
	// -race` to catch any torn state.
	const goroutines = 32
	r := NewRegistry()

	var wg sync.WaitGroup
	wg.Add(goroutines * 4)
	for i := 0; i < goroutines; i++ {
		i := i
		go func() {
			defer wg.Done()
			id := fmt.Sprintf("p-%d", i)
			r.Register(newStub(id, nil, nil))
		}()
		go func() {
			defer wg.Done()
			id := fmt.Sprintf("p-%d", i)
			_, _ = r.Get(id)
		}()
		go func() {
			defer wg.Done()
			id := fmt.Sprintf("p-%d", i)
			r.Has(id)
			_ = r.IDs()
			_ = r.Surfaces()
			_ = r.Size()
		}()
		go func() {
			defer wg.Done()
			id := fmt.Sprintf("p-%d", i)
			r.Unregister(id)
		}()
	}
	wg.Wait()
}
