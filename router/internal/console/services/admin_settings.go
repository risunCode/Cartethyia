package services

import (
	. "github.com/cartethyia/daemon/internal/console/contracts"
	"context"
	"encoding/json"
	"errors"
	"strings"

	dbrepositories "github.com/cartethyia/daemon/internal/storage/repositories"
	. "github.com/cartethyia/daemon/internal/console/api"

)

// postgresSettingsAdminService exposes only operator-safe runtime settings.
// Password hashes and JWT secrets remain in the repository and are never part
// of the admin response.
type postgresSettingsAdminService struct {
	repository  *dbrepositories.BunSettingsRepository
	environment string
	listenAddr  string
}

func newPostgresSettingsAdminService(repository *dbrepositories.BunSettingsRepository, environment, listenAddr string) *postgresSettingsAdminService {
	return &postgresSettingsAdminService{repository: repository, environment: strings.TrimSpace(environment), listenAddr: strings.TrimSpace(listenAddr)}
}

type runtimeSettingsDocument struct {
	LogLevel string          `json:"logLevel,omitempty"`
	Flags    map[string]bool `json:"flags,omitempty"`
	Metadata map[string]any  `json:"metadata,omitempty"`
}

func (s *postgresSettingsAdminService) Get(ctx context.Context) (RuntimeSettings, error) {
	if s == nil || s.repository == nil {
		return RuntimeSettings{}, dbrepositories.ErrRepositoryClosed
	}
	payload, err := s.document(ctx)
	if err != nil {
		return RuntimeSettings{}, err
	}
	level := payload.LogLevel
	if level == "" {
		level = "info"
	}
	return RuntimeSettings{Environment: s.environment, LogLevel: level, ListenAddr: s.listenAddr, Flags: cloneFlags(payload.Flags), Metadata: cloneMetadata(payload.Metadata)}, nil
}
func (s *postgresSettingsAdminService) Patch(ctx context.Context, input RuntimeSettingsInput) (RuntimeSettings, error) {
	if s == nil || s.repository == nil {
		return RuntimeSettings{}, dbrepositories.ErrRepositoryClosed
	}
	if input.ListenAddr != nil && strings.TrimSpace(*input.ListenAddr) != "" && strings.TrimSpace(*input.ListenAddr) != s.listenAddr {
		return RuntimeSettings{}, errors.New("runtime settings: listen address requires process restart")
	}
	patch := runtimeSettingsDocument{Flags: cloneFlags(input.Flags), Metadata: cloneMetadata(input.Metadata)}
	if input.LogLevel != nil {
		patch.LogLevel = strings.TrimSpace(*input.LogLevel)
	}
	raw, err := json.Marshal(patch)
	if err != nil {
		return RuntimeSettings{}, err
	}
	if _, err = s.repository.PatchSettingsJSON(ctx, raw); err != nil {
		return RuntimeSettings{}, err
	}
	return s.Get(ctx)
}
func (s *postgresSettingsAdminService) Reset(ctx context.Context) (RuntimeSettings, error) {
	if s == nil || s.repository == nil {
		return RuntimeSettings{}, dbrepositories.ErrRepositoryClosed
	}
	if _, err := s.repository.ResetSettingsJSON(ctx); err != nil {
		return RuntimeSettings{}, err
	}
	return s.Get(ctx)
}
func (s *postgresSettingsAdminService) document(ctx context.Context) (runtimeSettingsDocument, error) {
	if _, err := s.repository.Ensure(ctx); err != nil {
		return runtimeSettingsDocument{}, err
	}
	raw, err := s.repository.GetSettingsJSON(ctx)
	if err != nil {
		return runtimeSettingsDocument{}, err
	}
	var document runtimeSettingsDocument
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &document); err != nil {
			return runtimeSettingsDocument{}, errors.New("runtime settings: stored JSON is invalid")
		}
	}
	return document, nil
}
func cloneFlags(in map[string]bool) map[string]bool {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]bool, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}
func cloneMetadata(in map[string]any) map[string]any {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]any, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

var _ SettingsService = (*postgresSettingsAdminService)(nil)
