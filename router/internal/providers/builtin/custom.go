package builtin

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/cartethyia/daemon/internal/providers"
	"github.com/cartethyia/daemon/internal/providers/adapters"
)

// CustomProviderInput is the persisted, non-secret description of a user
// provider. CredentialRef points to the account/secret store and is never a
// credential value.
type CustomProviderInput struct {
	ID             string
	Slug           string
	Name           string
	Type           string
	Protocol       string
	Surface        string
	BaseURL        string
	CredentialRef  string
	CredentialRefs []string
	TimeoutSeconds int
	ModelsJSON     []byte
	HeadersJSON    []byte
}

// RegisterCustomProvider parses and registers one persisted provider. The
// provider is resolved immediately so malformed catalog data cannot remain in
// the registry and fail later during a request.
func RegisterCustomProvider(registry *providers.Registry, input CustomProviderInput) error {
	if registry == nil {
		return fmt.Errorf("custom provider registry is nil")
	}
	id := strings.TrimSpace(input.Slug)
	if id == "" {
		id = strings.TrimSpace(input.ID)
	}
	if id == "" {
		return fmt.Errorf("custom provider id is required")
	}
	for _, registeredID := range registry.IDs() {
		if registeredID == id {
			return fmt.Errorf("custom provider %q conflicts with a registered provider", id)
		}
	}
	if input.BaseURL == "" {
		return fmt.Errorf("custom provider %q requires base URL", id)
	}
	credentialRefs := append([]string(nil), input.CredentialRefs...)
	if input.CredentialRef != "" {
		credentialRefs = append([]string{input.CredentialRef}, credentialRefs...)
	}
	if len(credentialRefs) == 0 {
		return fmt.Errorf("custom provider %q requires at least one credential reference", id)
	}
	var models []providers.ProviderModel
	if len(input.ModelsJSON) > 0 && string(input.ModelsJSON) != "null" {
		if err := json.Unmarshal(input.ModelsJSON, &models); err != nil {
			return fmt.Errorf("custom provider %q models: %w", id, err)
		}
	}
	if len(models) == 0 {
		return fmt.Errorf("custom provider %q requires at least one model", id)
	}
	headers := http.Header{}
	if len(input.HeadersJSON) > 0 && string(input.HeadersJSON) != "null" {
		var raw map[string]string
		if err := json.Unmarshal(input.HeadersJSON, &raw); err != nil {
			return fmt.Errorf("custom provider %q headers: %w", id, err)
		}
		for key, value := range raw {
			if strings.TrimSpace(key) != "" {
				headers.Set(key, value)
			}
		}
	}
	var provider providers.Provider
	protocol := strings.TrimSpace(input.Protocol)
	if protocol == "" {
		if input.Type == "anthropic-compatible" || input.Type == "anthropic" {
			protocol = "anthropic"
		} else {
			protocol = "openai"
		}
	}
	surface := strings.TrimSpace(input.Surface)
	if surface == "" {
		if protocol == "anthropic" {
			surface = "anthropic-messages"
		} else {
			surface = "openai-chat"
		}
	}
	switch protocol {
	case "openai":
		if surface != "openai-chat" && surface != "openai-responses" {
			return fmt.Errorf("custom provider %q has unsupported OpenAI surface %q", id, surface)
		}
		provider = adapters.NewOpenAIAdapter(adapters.OpenAIAdapterConfig{
			ID: id, DisplayName: input.Name, BaseURL: input.BaseURL,
			CredentialRef: credentialRefs[0], CredentialKind: providers.CredentialManual,
			Headers: headers, Surfaces: []providers.Surface{providers.Surface(surface)}, Models: models,
		})
	case "anthropic":
		if surface != "anthropic-messages" {
			return fmt.Errorf("custom provider %q has unsupported Anthropic surface %q", id, surface)
		}
		provider = adapters.NewAnthropicAdapter(adapters.AnthropicAdapterConfig{
			ID: id, DisplayName: input.Name, BaseURL: input.BaseURL,
			CredentialRef: credentialRefs[0], CredentialKind: providers.CredentialManual,
			Headers: headers, Auth: "custom", Models: models,
		})
	default:
		return fmt.Errorf("custom provider %q has unsupported type %q", id, input.Type)
	}
	return registry.Register(provider)
}
