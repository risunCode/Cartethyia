package admin

import (
	"errors"
	"net/http"
	"strings"
)

const (
	// CatalogProvidersPath is the only browser-facing catalog route. Model
	// listings ride the provider payload. The external /v1/models route is not
	// an admin resource.
	CatalogProvidersPath = "/console/catalog/providers"

	maxCatalogProviderID = 128
	maxCatalogItems      = 512
)

// RegisterCatalog wires operator catalog reads. The catalog is intentionally a
// V2 admin contract; /v1/models remains external client protocol ingress.
//
// The routes stay registered when the service is absent so an authenticated
// operator receives an explicit unavailable response rather than a misleading
// 404. Authorization is applied by Register's scopedAdmin wrapper.
func RegisterCatalog(mux *http.ServeMux, services Services) {
	mux.HandleFunc(CatalogProvidersPath, requireMethod(http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
		if services.Catalog == nil {
			WriteError(w, NewError(CodeUnavailable, "catalog service is unavailable"))
			return
		}
		items, err := services.Catalog.Providers(r.Context())
		if err != nil {
			writeCatalogError(w, err)
			return
		}
		if len(items) > maxCatalogItems {
			WriteError(w, NewError(CodeUnavailable, "catalog provider list is unavailable"))
			return
		}
		safe := make([]CatalogProvider, 0, len(items))
		for _, item := range items {
			safe = append(safe, redactCatalogProvider(item))
		}
		WriteDataRequest(w, r, http.StatusOK, map[string]any{"items": safe})
	}))
}

func writeCatalogError(w http.ResponseWriter, err error) {
	var adminErr *Error
	if errors.As(err, &adminErr) {
		WriteError(w, adminErr)
		return
	}
	// Service implementations may wrap storage/provider failures. Do not let
	// those messages cross the operator boundary or turn into an unstable
	// provider-specific error contract.
	WriteError(w, NewError(CodeUnavailable, "catalog service is unavailable"))
}

func redactCatalogProvider(provider CatalogProvider) CatalogProvider {
	provider.ID = boundedCatalogString(provider.ID, maxCatalogProviderID)
	provider.DisplayName = boundedCatalogString(provider.DisplayName, maxCatalogProviderID)
	provider.Protocol = boundedCatalogString(provider.Protocol, maxCatalogProviderID)
	provider.Protocols = boundedCatalogStrings(provider.Protocols)
	provider.CredentialKind = allowedCredentialKind(provider.CredentialKind)
	provider.CredentialKinds = allowedCredentialKinds(provider.CredentialKinds)
	provider.AuthScope = boundedCatalogString(provider.AuthScope, maxCatalogProviderID)
	if len(provider.Models) > maxCatalogItems {
		provider.Models = provider.Models[:maxCatalogItems]
	}
	models := make([]CatalogModel, 0, len(provider.Models))
	for _, model := range provider.Models {
		models = append(models, redactCatalogModel(model))
	}
	provider.Models = models
	return provider
}

func redactCatalogModel(model CatalogModel) CatalogModel {
	model.ID = boundedCatalogString(model.ID, maxCatalogProviderID)
	model.ProviderID = boundedCatalogString(model.ProviderID, maxCatalogProviderID)
	model.DisplayName = boundedCatalogString(model.DisplayName, maxCatalogProviderID)
	model.Capabilities = boundedCatalogCapabilities(model.Capabilities)
	return model
}

func boundedCatalogString(value string, max int) string {
	value = strings.TrimSpace(value)
	if len(value) > max {
		return value[:max]
	}
	return value
}

func boundedCatalogStrings(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = boundedCatalogString(value, maxCatalogProviderID)
		if value != "" {
			out = append(out, value)
		}
		if len(out) == 32 {
			break
		}
	}
	return out
}

func boundedCatalogCapabilities(values map[string]bool) map[string]bool {
	if len(values) == 0 {
		return nil
	}
	allowed := map[string]struct{}{
		"chat": {}, "media": {}, "imageGeneration": {}, "videoGeneration": {},
		"streaming": {}, "reasoning": {}, "toolCalls": {}, "images": {},
		"explicitCache": {}, "promptCacheKey": {}, "search": {}, "tools": {},
	}
	out := make(map[string]bool, len(values))
	for key, value := range values {
		if _, ok := allowed[key]; ok {
			out[key] = value
		}
		if len(out) == 32 {
			break
		}
	}
	return out
}

func allowedCredentialKind(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "api_key", "oauth", "session", "manual", "none":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return "unknown"
	}
}

func allowedCredentialKinds(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = allowedCredentialKind(value)
		if value == "unknown" {
			continue
		}
		duplicate := false
		for _, previous := range out {
			if previous == value {
				duplicate = true
				break
			}
		}
		if !duplicate {
			out = append(out, value)
		}
		if len(out) == 8 {
			break
		}
	}
	return out
}
