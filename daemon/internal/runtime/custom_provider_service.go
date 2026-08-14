package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/cartethyia/daemon/internal/database/models"
	dbrepositories "github.com/cartethyia/daemon/internal/database/repositories"
	"github.com/cartethyia/daemon/internal/providers"
	"github.com/cartethyia/daemon/internal/providers/builtin"
	"github.com/cartethyia/daemon/internal/server/admin"
)

type customProviderAdminService struct {
	repository dbrepositories.CustomProviderRepository
	registry   *providers.Registry
}

func (s *customProviderAdminService) List(ctx context.Context) ([]admin.CustomProvider, error) {
	rows, err := s.repository.ListCustomProviders(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]admin.CustomProvider, 0, len(rows))
	for _, row := range rows {
		item, err := customProviderResponse(row)
		if err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, nil
}

func (s *customProviderAdminService) Get(ctx context.Context, id string) (admin.CustomProvider, error) {
	row, err := s.repository.GetCustomProvider(ctx, id)
	if err != nil {
		return admin.CustomProvider{}, err
	}
	return customProviderResponse(row)
}

func (s *customProviderAdminService) Upsert(ctx context.Context, input admin.CustomProviderInput) (admin.CustomProvider, error) {
	if s.registry == nil {
		return admin.CustomProvider{}, errors.New("custom provider registry is unavailable")
	}
	if existing, getErr := s.registry.Get(strings.TrimSpace(input.Slug)); getErr == nil && existing != nil {
		stored, providerErr := s.repository.GetCustomProviderBySlug(ctx, strings.TrimSpace(input.Slug))
		if providerErr != nil || (input.ID != "" && strings.TrimSpace(input.ID) != stored.ID) {
			return admin.CustomProvider{}, fmt.Errorf("custom provider %q conflicts with an existing provider", input.Slug)
		}
	}
	modelsJSON, err := json.Marshal(input.Models)
	if err != nil {
		return admin.CustomProvider{}, fmt.Errorf("custom provider models: %w", err)
	}
	headersJSON, err := json.Marshal(input.Headers)
	if err != nil {
		return admin.CustomProvider{}, fmt.Errorf("custom provider headers: %w", err)
	}
	row := models.CustomProvider{
		ID: strings.TrimSpace(input.ID), Slug: strings.TrimSpace(input.Slug), Name: strings.TrimSpace(input.Name),
		Type: strings.TrimSpace(input.Type), Protocol: strings.TrimSpace(input.Protocol), Surface: strings.TrimSpace(input.Surface), BaseURL: strings.TrimSpace(input.BaseURL), CredentialRef: strings.TrimSpace(input.CredentialRef),
		CredentialRefs: append([]string(nil), input.CredentialRefs...),
		TimeoutSeconds: input.TimeoutSeconds, Models: modelsJSON, CustomHeaders: headersJSON,
	}
	stored, err := s.repository.UpsertCustomProvider(ctx, row)
	if err != nil {
		return admin.CustomProvider{}, err
	}
	s.registry.Unregister(stored.Slug)
	if err := builtin.RegisterCustomProvider(s.registry, builtin.CustomProviderInput{
		ID: stored.ID, Slug: stored.Slug, Name: stored.Name, Type: stored.Type, Protocol: stored.Protocol, Surface: stored.Surface, BaseURL: stored.BaseURL,
		CredentialRef: stored.CredentialRef, CredentialRefs: stored.CredentialRefs, TimeoutSeconds: stored.TimeoutSeconds, ModelsJSON: stored.Models, HeadersJSON: stored.CustomHeaders,
	}); err != nil {
		return admin.CustomProvider{}, err
	}
	return customProviderResponse(stored)
}

func (s *customProviderAdminService) Delete(ctx context.Context, id string) error {
	deleted, err := s.repository.DeleteCustomProvider(ctx, id)
	if err != nil {
		return err
	}
	if !deleted {
		return fmt.Errorf("custom provider %q was not found", id)
	}
	if s.registry != nil {
		s.registry.Unregister(id)
	}
	return nil
}

func customProviderResponse(row models.CustomProvider) (admin.CustomProvider, error) {
	var modelsValue []any
	if len(row.Models) > 0 && string(row.Models) != "null" {
		if err := json.Unmarshal(row.Models, &modelsValue); err != nil {
			return admin.CustomProvider{}, err
		}
	}
	var headers map[string]string
	if len(row.CustomHeaders) > 0 && string(row.CustomHeaders) != "null" {
		if err := json.Unmarshal(row.CustomHeaders, &headers); err != nil {
			return admin.CustomProvider{}, err
		}
	}
	return admin.CustomProvider{ID: row.ID, Slug: row.Slug, Name: row.Name, Type: row.Type, Protocol: row.Protocol, Surface: row.Surface, BaseURL: row.BaseURL, CredentialRef: row.CredentialRef, CredentialRefs: append([]string(nil), row.CredentialRefs...), TimeoutSeconds: row.TimeoutSeconds, Models: modelsValue, Headers: headers}, nil
}
