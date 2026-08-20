package builtin

import (
	"github.com/cartethyia/daemon/internal/accounts/auth"
	"github.com/cartethyia/daemon/internal/providers"
)

// DefaultRegistry is the composition root for concrete provider packages.
func DefaultRegistry() (*providers.Registry, error) {
	r := providers.NewRegistry()
	for _, definition := range Definitions() {
		provider, err := materialize(definition)
		if err != nil {
			return nil, err
		}
		if err := r.Register(provider); err != nil {
			return nil, err
		}
	}
	for _, definition := range auth.Definitions() {
		provider, err := materialize(fromAuthDefinition(definition))
		if err != nil {
			return nil, err
		}
		if err := r.Register(provider); err != nil {
			return nil, err
		}
	}
	for _, definition := range providers.SpecialDefinitions() {
		provider, err := materialize(definition)
		if err != nil {
			return nil, err
		}
		if err := r.Register(provider); err != nil {
			return nil, err
		}
	}
	return r, nil
}
