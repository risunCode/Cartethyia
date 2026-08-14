package repositories

import (
	"context"

	"github.com/cartethyia/daemon/internal/database/models"
)

// SettingsRepository owns the singleton settings table plus its small
// companion tables: model_aliases, combos, access_rules, provider_models,
// cli_tool_mapping_settings, cli_model_mappings, filter_rules.
type SettingsRepository interface {
	Ensure(ctx context.Context) (models.Settings, error)
	Get(ctx context.Context) (models.Settings, error)
	GetSettingsJSON(ctx context.Context) ([]byte, error)
	PatchSettingsJSON(ctx context.Context, patch []byte) ([]byte, error)
	SetPasswordHash(ctx context.Context, hash string) error
	BumpPasswordVersion(ctx context.Context) error
	RotateJWTSecret(ctx context.Context, secret string) error

	ListAliases(ctx context.Context) ([]models.ModelAlias, error)
	GetAlias(ctx context.Context, alias string) (models.ModelAlias, error)
	UpsertAlias(ctx context.Context, alias, model string) (models.ModelAlias, error)
	DeleteAlias(ctx context.Context, alias string) (bool, error)

	ListCombos(ctx context.Context) ([]models.Combo, error)
	GetCombo(ctx context.Context, id string) (models.Combo, error)
	UpsertCombo(ctx context.Context, combo models.Combo) (models.Combo, error)
	DeleteCombo(ctx context.Context, id string) (bool, error)

	GetAccessRule(ctx context.Context, scope string) (models.AccessRule, error)
	UpsertAccessRule(ctx context.Context, rule models.AccessRule) (models.AccessRule, error)

	ListProviderModels(ctx context.Context, provider string) ([]models.ProviderModel, error)
	GetProviderModel(ctx context.Context, provider, modelID string) (models.ProviderModel, error)
	UpsertProviderModel(ctx context.Context, model models.ProviderModel) (models.ProviderModel, error)
	DeleteProviderModel(ctx context.Context, provider, modelID string) (bool, error)

	ListCliMappings(ctx context.Context, toolID string) ([]models.CliModelMapping, error)
	UpsertCliMapping(ctx context.Context, mapping models.CliModelMapping) (models.CliModelMapping, error)
	DeleteCliMapping(ctx context.Context, toolID, slotKey string) (bool, error)
	GetCliMappingSettings(ctx context.Context, toolID string) (models.CliMappingSettings, error)
	SetCliMappingEnabled(ctx context.Context, toolID string, enabled bool) (models.CliMappingSettings, error)
	ResetCliMappings(ctx context.Context, toolID string) error

	ListFilterRules(ctx context.Context) ([]models.FilterRule, error)
	UpsertFilterRule(ctx context.Context, rule models.FilterRule) (models.FilterRule, error)
	DeleteFilterRule(ctx context.Context, id int64) (bool, error)
}
