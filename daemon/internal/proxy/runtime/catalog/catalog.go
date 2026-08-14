package catalog

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/cartethyia/daemon/internal/providers"
)

const (
	MaxAliasDepth     = 16
	MaxComboMembers   = 64
	MaxSnapshotModels = 4096
)

var (
	ErrUnknownModel = errors.New("catalog: unknown model")
	ErrAliasCycle   = errors.New("catalog: alias cycle")
	ErrAliasDepth   = errors.New("catalog: alias depth exceeded")
	ErrEmptyCombo   = errors.New("catalog: combination has no members")
)

type Alias struct {
	Alias  string
	Target string
}
type Combination struct {
	ID       string
	Members  []string
	Strategy string
}

type Source interface {
	Aliases() ([]Alias, error)
	Combinations() ([]Combination, error)
	Generation() uint64
}

type Snapshot struct {
	Generation   uint64
	Providers    []string
	Models       map[string]Model
	Aliases      map[string]string
	Combinations map[string]Combination
}
type Model struct {
	ID          string
	ProviderID  string
	UpstreamID  string
	Surfaces    []providers.Surface
	Combination bool
}

func (s *Snapshot) Resolve(modelID string) (Model, error) {
	if s == nil {
		return Model{}, ErrUnknownModel
	}
	if target, ok := s.Aliases[modelID]; ok {
		modelID = target
	}
	if model, ok := s.Models[modelID]; ok {
		return model, nil
	}
	if combo, ok := s.Combinations[modelID]; ok {
		return Model{ID: combo.ID, Combination: true}, nil
	}
	return Model{}, fmt.Errorf("%w: %s", ErrUnknownModel, modelID)
}

func (s *Snapshot) Clone() *Snapshot {
	if s == nil {
		return nil
	}
	out := &Snapshot{Generation: s.Generation, Providers: append([]string(nil), s.Providers...), Models: make(map[string]Model, len(s.Models)), Aliases: make(map[string]string, len(s.Aliases)), Combinations: make(map[string]Combination, len(s.Combinations))}
	for k, v := range s.Models {
		v.Surfaces = append([]providers.Surface(nil), v.Surfaces...)
		out.Models[k] = v
	}
	for k, v := range s.Aliases {
		out.Aliases[k] = v
	}
	for k, v := range s.Combinations {
		v.Members = append([]string(nil), v.Members...)
		out.Combinations[k] = v
	}
	return out
}

type Builder struct {
	registry   *providers.Registry
	generation atomic.Uint64
	mu         sync.Mutex
	building   bool
	pending    bool
	last       *Snapshot
}

func NewBuilder(registry *providers.Registry) (*Builder, error) {
	if registry == nil {
		return nil, errors.New("catalog: registry is required")
	}
	return &Builder{registry: registry}, nil
}

func (b *Builder) Build(source Source) (*Snapshot, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if source == nil {
		return nil, errors.New("catalog: source is required")
	}
	aliases, err := source.Aliases()
	if err != nil {
		return nil, fmt.Errorf("catalog aliases: %w", err)
	}
	combos, err := source.Combinations()
	if err != nil {
		return nil, fmt.Errorf("catalog combinations: %w", err)
	}
	s := &Snapshot{Generation: source.Generation(), Models: map[string]Model{}, Aliases: map[string]string{}, Combinations: map[string]Combination{}}
	s.Providers = b.registry.IDs()
	for _, pid := range s.Providers {
		p, err := b.registry.Get(pid)
		if err != nil {
			return nil, err
		}
		for _, m := range p.Models().List() {
			up := m.UpstreamID
			if up == "" {
				up = m.ID
			}
			surfaces := m.Surfaces
			if len(surfaces) == 0 {
				surfaces = p.Capabilities().Surfaces
			}
			s.Models[m.ID] = Model{ID: m.ID, ProviderID: pid, UpstreamID: up, Surfaces: append([]providers.Surface(nil), surfaces...)}
		}
	}
	for _, a := range aliases {
		a.Alias = strings.TrimSpace(a.Alias)
		a.Target = strings.TrimSpace(a.Target)
		if a.Alias == "" || a.Target == "" {
			return nil, errors.New("catalog: empty alias")
		}
		if _, exists := s.Aliases[a.Alias]; exists {
			return nil, fmt.Errorf("catalog: duplicate alias %s", a.Alias)
		}
		s.Aliases[a.Alias] = a.Target
	}
	for alias := range s.Aliases {
		target, err := resolveAlias(s.Aliases, alias)
		if err != nil {
			return nil, err
		}
		s.Aliases[alias] = target
	}
	for _, c := range combos {
		c.ID = strings.TrimSpace(c.ID)
		if c.ID == "" || len(c.Members) == 0 {
			return nil, ErrEmptyCombo
		}
		if len(c.Members) > MaxComboMembers {
			return nil, fmt.Errorf("catalog: combo %s exceeds member bound", c.ID)
		}
		if _, ok := s.Combinations[c.ID]; ok {
			return nil, fmt.Errorf("catalog: duplicate combo %s", c.ID)
		}
		for i, m := range c.Members {
			target, err := resolveAlias(s.Aliases, m)
			if err != nil {
				return nil, err
			}
			if _, ok := s.Models[target]; !ok {
				return nil, fmt.Errorf("catalog combo %s: %w: %s", c.ID, ErrUnknownModel, target)
			}
			c.Members[i] = target
		}
		s.Combinations[c.ID] = Combination{ID: c.ID, Members: append([]string(nil), c.Members...), Strategy: c.Strategy}
	}
	if len(s.Models) > MaxSnapshotModels {
		return nil, errors.New("catalog: snapshot model bound exceeded")
	}
	b.last = s.Clone()
	b.generation.Store(s.Generation)
	return s, nil
}

func resolveAlias(aliases map[string]string, start string) (string, error) {
	seen := map[string]bool{}
	cur := start
	for depth := 0; depth < MaxAliasDepth; depth++ {
		target, ok := aliases[cur]
		if !ok {
			return cur, nil
		}
		if seen[cur] {
			return "", fmt.Errorf("%w: %s", ErrAliasCycle, start)
		}
		seen[cur] = true
		cur = target
	}
	return "", fmt.Errorf("%w: %s", ErrAliasDepth, start)
}

func (b *Builder) Last() *Snapshot { b.mu.Lock(); defer b.mu.Unlock(); return b.last.Clone() }
func (s *Snapshot) ModelIDs() []string {
	if s == nil {
		return nil
	}
	out := make([]string, 0, len(s.Models)+len(s.Combinations))
	for id := range s.Models {
		out = append(out, id)
	}
	for id := range s.Combinations {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

type StaticSource struct {
	AliasList       []Alias
	CombinationList []Combination
	Gen             uint64
}

func (s StaticSource) Aliases() ([]Alias, error) { return append([]Alias(nil), s.AliasList...), nil }
func (s StaticSource) Combinations() ([]Combination, error) {
	return append([]Combination(nil), s.CombinationList...), nil
}
func (s StaticSource) Generation() uint64 { return s.Gen }
