package repositories

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/cartethyia/daemon/internal/database/models"
	"github.com/uptrace/bun"
)

const (
	maxSettingsJSON = 128 << 10
	maxSettingsText = 256
	maxSettingsRows = 4096
)

// BunSettingsRepository is the PostgreSQL implementation of SettingsRepository.
// It keeps the singleton and all operator-managed settings tables on the same
// Bun handle; no process-local state is used as a fallback.
type BunSettingsRepository struct{ db *bun.DB }

func NewBunSettingsRepository(db *bun.DB) *BunSettingsRepository {
	return &BunSettingsRepository{db: db}
}

type settingsRow struct {
	bun.BaseModel   `bun:"table:settings"`
	PasswordHash    *string   `bun:"password_hash"`
	PasswordVersion int       `bun:"password_version"`
	JWTSecret       *string   `bun:"jwt_secret"`
	SettingsJSON    []byte    `bun:"settings_json,type:jsonb"`
	InitializedAt   time.Time `bun:"initialized_at"`
	UpdatedAt       time.Time `bun:"updated_at"`
}

func (r *BunSettingsRepository) Ensure(ctx context.Context) (models.Settings, error) {
	if r == nil || r.db == nil {
		return models.Settings{}, ErrRepositoryClosed
	}
	now := time.Now().UTC()
	if _, err := r.db.NewRaw(`INSERT INTO settings (id,password_version,settings_json,initialized_at,updated_at) VALUES (1,1,'{}'::jsonb,?,?) ON CONFLICT (id) DO NOTHING`, now, now).Exec(ctx); err != nil {
		return models.Settings{}, err
	}
	return r.Get(ctx)
}
func (r *BunSettingsRepository) Get(ctx context.Context) (models.Settings, error) {
	if r == nil || r.db == nil {
		return models.Settings{}, ErrRepositoryClosed
	}
	var row settingsRow
	if err := r.db.NewSelect().Model(&row).Where("id = 1").Scan(ctx); err != nil {
		return models.Settings{}, err
	}
	return models.Settings{PasswordHash: valueString(row.PasswordHash), PasswordVersion: row.PasswordVersion, JWTSecret: valueString(row.JWTSecret), SettingsJSON: append([]byte(nil), row.SettingsJSON...), InitializedAt: row.InitializedAt, UpdatedAt: row.UpdatedAt}, nil
}
func (r *BunSettingsRepository) GetSettingsJSON(ctx context.Context) ([]byte, error) {
	v, err := r.Get(ctx)
	if err != nil {
		return nil, err
	}
	return append([]byte(nil), v.SettingsJSON...), nil
}
func (r *BunSettingsRepository) PatchSettingsJSON(ctx context.Context, patch []byte) ([]byte, error) {
	if r == nil || r.db == nil {
		return nil, ErrRepositoryClosed
	}
	merged, err := r.mergeSettings(ctx, patch)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	if _, err = r.db.NewRaw(`INSERT INTO settings (id,password_version,settings_json,initialized_at,updated_at) VALUES (1,1,?, ?, ?) ON CONFLICT (id) DO UPDATE SET settings_json=EXCLUDED.settings_json,updated_at=EXCLUDED.updated_at`, merged, now, now).Exec(ctx); err != nil {
		return nil, err
	}
	return merged, nil
}
func (r *BunSettingsRepository) mergeSettings(ctx context.Context, patch []byte) ([]byte, error) {
	if len(patch) == 0 || len(patch) > maxSettingsJSON {
		return nil, fmt.Errorf("settings: JSON patch must be between 1 and %d bytes", maxSettingsJSON)
	}
	var p map[string]any
	if err := json.Unmarshal(patch, &p); err != nil || p == nil {
		return nil, errors.New("settings: JSON patch must be an object")
	}
	current, err := r.GetSettingsJSON(ctx)
	if err != nil {
		// Ensure makes first-use development/test setup deterministic while still
		// surfacing all other PostgreSQL errors to the caller.
		if _, ensureErr := r.Ensure(ctx); ensureErr != nil {
			return nil, err
		}
		current, err = r.GetSettingsJSON(ctx)
		if err != nil {
			return nil, err
		}
	}
	var c map[string]any
	if len(current) > 0 {
		_ = json.Unmarshal(current, &c)
	}
	if c == nil {
		c = map[string]any{}
	}
	mergeJSONObjects(c, p)
	out, err := json.Marshal(c)
	if err != nil {
		return nil, err
	}
	if len(out) > maxSettingsJSON {
		return nil, fmt.Errorf("settings: JSON exceeds %d bytes", maxSettingsJSON)
	}
	return out, nil
}
func mergeJSONObjects(dst, patch map[string]any) {
	for key, value := range patch {
		if value == nil {
			delete(dst, key)
			continue
		}
		pm, ok := value.(map[string]any)
		if !ok {
			dst[key] = value
			continue
		}
		cm, _ := dst[key].(map[string]any)
		if cm == nil {
			cm = map[string]any{}
			dst[key] = cm
		}
		mergeJSONObjects(cm, pm)
	}
}
func (r *BunSettingsRepository) ResetSettingsJSON(ctx context.Context) ([]byte, error) {
	if r == nil || r.db == nil {
		return nil, ErrRepositoryClosed
	}
	now := time.Now().UTC()
	if _, err := r.db.NewRaw(`INSERT INTO settings (id,password_version,settings_json,initialized_at,updated_at) VALUES (1,1,'{}'::jsonb,?,?) ON CONFLICT (id) DO UPDATE SET settings_json='{}'::jsonb,updated_at=EXCLUDED.updated_at`, now, now).Exec(ctx); err != nil {
		return nil, err
	}
	return []byte(`{}`), nil
}
func (r *BunSettingsRepository) SetPasswordHash(ctx context.Context, hash string) error {
	if r == nil || r.db == nil {
		return ErrRepositoryClosed
	}
	hash = strings.TrimSpace(hash)
	if len(hash) > maxSettingsText {
		return errors.New("settings: password hash is bounded")
	}
	_, err := r.db.NewRaw(`UPDATE settings SET password_hash=?,updated_at=? WHERE id=1`, nullable(hash), time.Now().UTC()).Exec(ctx)
	return err
}
func (r *BunSettingsRepository) BumpPasswordVersion(ctx context.Context) error {
	if r == nil || r.db == nil {
		return ErrRepositoryClosed
	}
	_, err := r.db.NewRaw(`UPDATE settings SET password_version=password_version+1,updated_at=? WHERE id=1`, time.Now().UTC()).Exec(ctx)
	return err
}
func (r *BunSettingsRepository) RotateJWTSecret(ctx context.Context, secret string) error {
	if r == nil || r.db == nil {
		return ErrRepositoryClosed
	}
	if len(secret) > maxSettingsText {
		return errors.New("settings: JWT secret is bounded")
	}
	_, err := r.db.NewRaw(`UPDATE settings SET jwt_secret=?,updated_at=? WHERE id=1`, nullable(secret), time.Now().UTC()).Exec(ctx)
	return err
}

type aliasSettingsRow struct {
	bun.BaseModel `bun:"table:model_aliases"`
	Alias         string    `bun:"alias"`
	Model         string    `bun:"model"`
	CreatedAt     time.Time `bun:"created_at"`
}

type comboSettingsRow struct {
	bun.BaseModel `bun:"table:combos"`
	ID            string    `bun:"id"`
	Name          string    `bun:"name"`
	ModelsJSON    []byte    `bun:"models_json,type:jsonb"`
	Strategy      string    `bun:"strategy"`
	StickyLimit   int       `bun:"sticky_limit"`
	CreatedAt     time.Time `bun:"created_at"`
	UpdatedAt     time.Time `bun:"updated_at"`
}

type accessSettingsRow struct {
	bun.BaseModel `bun:"table:access_rules"`
	Scope         string    `bun:"scope"`
	Mode          string    `bun:"mode"`
	Entries       []byte    `bun:"entries_json,type:jsonb"`
	UpdatedAt     time.Time `bun:"updated_at"`
}

type providerSettingsRow struct {
	bun.BaseModel `bun:"table:provider_models"`
	Provider      string    `bun:"provider"`
	ModelID       string    `bun:"model_id"`
	Enabled       bool      `bun:"enabled"`
	Source        string    `bun:"source"`
	CreatedAt     time.Time `bun:"created_at"`
	UpdatedAt     time.Time `bun:"updated_at"`
}

type cliMapRow struct {
	bun.BaseModel `bun:"table:cli_model_mappings"`
	ToolID        string    `bun:"tool_id"`
	SlotKey       string    `bun:"slot_key"`
	SourceModel   string    `bun:"source_model"`
	TargetModel   string    `bun:"target_model"`
	Enabled       bool      `bun:"enabled"`
	CreatedAt     time.Time `bun:"created_at"`
	UpdatedAt     time.Time `bun:"updated_at"`
}

type cliSettingRow struct {
	bun.BaseModel `bun:"table:cli_tool_mapping_settings"`
	ToolID        string    `bun:"tool_id"`
	Enabled       bool      `bun:"enabled"`
	UpdatedAt     time.Time `bun:"updated_at"`
}

type filterSettingsRow struct {
	bun.BaseModel `bun:"table:filter_rules"`
	ID            int64      `bun:"id,pk"`
	RuleID        string     `bun:"rule_id"`
	Pattern       string     `bun:"pattern"`
	Replacement   string     `bun:"replacement"`
	IsActive      bool       `bun:"is_active"`
	IsRegex       bool       `bun:"is_regex"`
	SortOrder     int        `bun:"sort_order"`
	CreatedAt     time.Time  `bun:"created_at"`
	UpdatedAt     *time.Time `bun:"updated_at"`
}

func (r *BunSettingsRepository) ListAliases(ctx context.Context) ([]models.ModelAlias, error) {
	if r == nil || r.db == nil {
		return nil, ErrRepositoryClosed
	}
	rows := []aliasSettingsRow{}
	if err := r.db.NewSelect().Model(&rows).Order("alias ASC").Limit(maxSettingsRows).Scan(ctx); err != nil {
		return nil, err
	}
	out := make([]models.ModelAlias, len(rows))
	for i, v := range rows {
		out[i] = models.ModelAlias{Alias: v.Alias, Model: v.Model, CreatedAt: v.CreatedAt}
	}
	return out, nil
}
func (r *BunSettingsRepository) GetAlias(ctx context.Context, alias string) (models.ModelAlias, error) {
	if r == nil || r.db == nil {
		return models.ModelAlias{}, ErrRepositoryClosed
	}
	var v aliasSettingsRow
	if err := r.db.NewSelect().Model(&v).Where("alias = ?", boundedString(alias, maxSettingsText)).Scan(ctx); err != nil {
		return models.ModelAlias{}, err
	}
	return models.ModelAlias{Alias: v.Alias, Model: v.Model, CreatedAt: v.CreatedAt}, nil
}
func (r *BunSettingsRepository) UpsertAlias(ctx context.Context, alias, model string) (models.ModelAlias, error) {
	alias, model, err := settingsPair(alias, model)
	if err != nil {
		return models.ModelAlias{}, err
	}
	if r == nil || r.db == nil {
		return models.ModelAlias{}, ErrRepositoryClosed
	}
	now := time.Now().UTC()
	_, err = r.db.NewRaw(`INSERT INTO model_aliases(alias,model,created_at) VALUES(?,?,?) ON CONFLICT(alias) DO UPDATE SET model=EXCLUDED.model`, alias, model, now).Exec(ctx)
	if err != nil {
		return models.ModelAlias{}, err
	}
	return r.GetAlias(ctx, alias)
}
func (r *BunSettingsRepository) DeleteAlias(ctx context.Context, alias string) (bool, error) {
	if r == nil || r.db == nil {
		return false, ErrRepositoryClosed
	}
	res, err := r.db.NewRaw(`DELETE FROM model_aliases WHERE alias=?`, boundedString(alias, maxSettingsText)).Exec(ctx)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}
func (r *BunSettingsRepository) ListCombos(ctx context.Context) ([]models.Combo, error) {
	if r == nil || r.db == nil {
		return nil, ErrRepositoryClosed
	}
	rows := []comboSettingsRow{}
	if err := r.db.NewSelect().Model(&rows).Order("id ASC").Limit(maxSettingsRows).Scan(ctx); err != nil {
		return nil, err
	}
	out := make([]models.Combo, len(rows))
	for i, v := range rows {
		if err := json.Unmarshal(v.ModelsJSON, &out[i].Models); err != nil {
			return nil, fmt.Errorf("settings: decode combo %s: %w", v.ID, err)
		}
		out[i].ID = v.ID
		out[i].Name = v.Name
		out[i].Strategy = v.Strategy
		out[i].StickyLimit = v.StickyLimit
		out[i].CreatedAt = v.CreatedAt
		out[i].UpdatedAt = v.UpdatedAt
	}
	return out, nil
}
func (r *BunSettingsRepository) GetCombo(ctx context.Context, id string) (models.Combo, error) {
	all, err := r.ListCombos(ctx)
	if err != nil {
		return models.Combo{}, err
	}
	for _, v := range all {
		if v.ID == strings.TrimSpace(id) {
			return v, nil
		}
	}
	return models.Combo{}, fmt.Errorf("settings: combo %q not found", boundedString(id, maxSettingsText))
}
func (r *BunSettingsRepository) UpsertCombo(ctx context.Context, v models.Combo) (models.Combo, error) {
	if r == nil || r.db == nil {
		return models.Combo{}, ErrRepositoryClosed
	}
	if strings.TrimSpace(v.ID) == "" || len(v.ID) > maxSettingsText || strings.TrimSpace(v.Name) == "" || len(v.Name) > maxSettingsText || len(v.Models) > 256 {
		return models.Combo{}, errors.New("settings: invalid combo")
	}
	raw, err := json.Marshal(v.Models)
	if err != nil {
		return models.Combo{}, err
	}
	now := time.Now().UTC()
	if v.CreatedAt.IsZero() {
		v.CreatedAt = now
	}
	if v.UpdatedAt.IsZero() {
		v.UpdatedAt = now
	}
	_, err = r.db.NewRaw(`INSERT INTO combos(id,name,models_json,strategy,sticky_limit,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,models_json=EXCLUDED.models_json,strategy=EXCLUDED.strategy,sticky_limit=EXCLUDED.sticky_limit,updated_at=EXCLUDED.updated_at`, v.ID, v.Name, raw, v.Strategy, v.StickyLimit, v.CreatedAt, v.UpdatedAt).Exec(ctx)
	if err != nil {
		return models.Combo{}, err
	}
	return r.GetCombo(ctx, v.ID)
}
func (r *BunSettingsRepository) DeleteCombo(ctx context.Context, id string) (bool, error) {
	if r == nil || r.db == nil {
		return false, ErrRepositoryClosed
	}
	res, err := r.db.NewRaw(`DELETE FROM combos WHERE id=?`, boundedString(id, maxSettingsText)).Exec(ctx)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}
func (r *BunSettingsRepository) GetAccessRule(ctx context.Context, scope string) (models.AccessRule, error) {
	if r == nil || r.db == nil {
		return models.AccessRule{}, ErrRepositoryClosed
	}
	var v accessSettingsRow
	if err := r.db.NewSelect().Model(&v).Where("scope=?", boundedString(scope, maxSettingsText)).Scan(ctx); err != nil {
		return models.AccessRule{}, err
	}
	return models.AccessRule{Scope: v.Scope, Mode: v.Mode, Entries: append([]byte(nil), v.Entries...), UpdatedAt: v.UpdatedAt}, nil
}
func (r *BunSettingsRepository) UpsertAccessRule(ctx context.Context, v models.AccessRule) (models.AccessRule, error) {
	if r == nil || r.db == nil {
		return models.AccessRule{}, ErrRepositoryClosed
	}
	if strings.TrimSpace(v.Scope) == "" || len(v.Scope) > maxSettingsText || len(v.Entries) > maxSettingsJSON {
		return models.AccessRule{}, errors.New("settings: invalid access rule")
	}
	if len(v.Entries) == 0 {
		v.Entries = []byte(`[]`)
	}
	v.UpdatedAt = time.Now().UTC()
	_, err := r.db.NewRaw(`INSERT INTO access_rules(scope,mode,entries_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(scope) DO UPDATE SET mode=EXCLUDED.mode,entries_json=EXCLUDED.entries_json,updated_at=EXCLUDED.updated_at`, v.Scope, v.Mode, v.Entries, v.UpdatedAt).Exec(ctx)
	if err != nil {
		return models.AccessRule{}, err
	}
	return r.GetAccessRule(ctx, v.Scope)
}
func (r *BunSettingsRepository) ListProviderModels(ctx context.Context, provider string) ([]models.ProviderModel, error) {
	if r == nil || r.db == nil {
		return nil, ErrRepositoryClosed
	}
	rows := []providerSettingsRow{}
	q := r.db.NewSelect().Model(&rows).OrderExpr("provider ASC, model_id ASC").Limit(maxSettingsRows)
	if p := strings.TrimSpace(provider); p != "" {
		q = q.Where("provider=?", boundedString(p, maxSettingsText))
	}
	if err := q.Scan(ctx); err != nil {
		return nil, err
	}
	out := make([]models.ProviderModel, len(rows))
	for i, v := range rows {
		out[i] = models.ProviderModel{Provider: v.Provider, ModelID: v.ModelID, Enabled: v.Enabled, Source: v.Source, CreatedAt: v.CreatedAt, UpdatedAt: v.UpdatedAt}
	}
	return out, nil
}
func (r *BunSettingsRepository) GetProviderModel(ctx context.Context, p, m string) (models.ProviderModel, error) {
	all, err := r.ListProviderModels(ctx, p)
	if err != nil {
		return models.ProviderModel{}, err
	}
	for _, v := range all {
		if v.ModelID == strings.TrimSpace(m) {
			return v, nil
		}
	}
	return models.ProviderModel{}, fmt.Errorf("settings: provider model %q/%q not found", boundedString(p, maxSettingsText), boundedString(m, maxSettingsText))
}
func (r *BunSettingsRepository) UpsertProviderModel(ctx context.Context, v models.ProviderModel) (models.ProviderModel, error) {
	if r == nil || r.db == nil {
		return models.ProviderModel{}, ErrRepositoryClosed
	}
	if strings.TrimSpace(v.Provider) == "" || strings.TrimSpace(v.ModelID) == "" || len(v.Provider) > maxSettingsText || len(v.ModelID) > maxSettingsText {
		return models.ProviderModel{}, errors.New("settings: invalid provider model")
	}
	now := time.Now().UTC()
	if v.CreatedAt.IsZero() {
		v.CreatedAt = now
	}
	if v.UpdatedAt.IsZero() {
		v.UpdatedAt = now
	}
	_, err := r.db.NewRaw(`INSERT INTO provider_models(provider,model_id,enabled,source,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(provider,model_id) DO UPDATE SET enabled=EXCLUDED.enabled,source=EXCLUDED.source,updated_at=EXCLUDED.updated_at`, v.Provider, v.ModelID, v.Enabled, v.Source, v.CreatedAt, v.UpdatedAt).Exec(ctx)
	if err != nil {
		return models.ProviderModel{}, err
	}
	return r.GetProviderModel(ctx, v.Provider, v.ModelID)
}
func (r *BunSettingsRepository) DeleteProviderModel(ctx context.Context, p, m string) (bool, error) {
	if r == nil || r.db == nil {
		return false, ErrRepositoryClosed
	}
	res, err := r.db.NewRaw(`DELETE FROM provider_models WHERE provider=? AND model_id=?`, boundedString(p, maxSettingsText), boundedString(m, maxSettingsText)).Exec(ctx)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}
func (r *BunSettingsRepository) ListCliMappings(ctx context.Context, tool string) ([]models.CliModelMapping, error) {
	if r == nil || r.db == nil {
		return nil, ErrRepositoryClosed
	}
	rows := []cliMapRow{}
	q := r.db.NewSelect().Model(&rows).OrderExpr("tool_id ASC, slot_key ASC").Limit(maxSettingsRows)
	if strings.TrimSpace(tool) != "" {
		q = q.Where("tool_id=?", boundedString(tool, maxSettingsText))
	}
	if err := q.Scan(ctx); err != nil {
		return nil, err
	}
	out := make([]models.CliModelMapping, len(rows))
	for i, v := range rows {
		out[i] = models.CliModelMapping{ToolID: v.ToolID, SlotKey: v.SlotKey, SourceModel: v.SourceModel, TargetModel: v.TargetModel, Enabled: v.Enabled, CreatedAt: v.CreatedAt, UpdatedAt: v.UpdatedAt}
	}
	return out, nil
}
func (r *BunSettingsRepository) UpsertCliMapping(ctx context.Context, v models.CliModelMapping) (models.CliModelMapping, error) {
	if r == nil || r.db == nil {
		return models.CliModelMapping{}, ErrRepositoryClosed
	}
	if strings.TrimSpace(v.ToolID) == "" || strings.TrimSpace(v.SlotKey) == "" || len(v.ToolID) > maxSettingsText || len(v.SlotKey) > maxSettingsText {
		return models.CliModelMapping{}, errors.New("settings: invalid CLI mapping")
	}
	now := time.Now().UTC()
	if v.CreatedAt.IsZero() {
		v.CreatedAt = now
	}
	if v.UpdatedAt.IsZero() {
		v.UpdatedAt = now
	}
	_, err := r.db.NewRaw(`INSERT INTO cli_model_mappings(tool_id,slot_key,source_model,target_model,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(tool_id,slot_key) DO UPDATE SET source_model=EXCLUDED.source_model,target_model=EXCLUDED.target_model,enabled=EXCLUDED.enabled,updated_at=EXCLUDED.updated_at`, v.ToolID, v.SlotKey, v.SourceModel, v.TargetModel, v.Enabled, v.CreatedAt, v.UpdatedAt).Exec(ctx)
	if err != nil {
		return models.CliModelMapping{}, err
	}
	all, err := r.ListCliMappings(ctx, v.ToolID)
	if err != nil {
		return models.CliModelMapping{}, err
	}
	for _, m := range all {
		if m.SlotKey == v.SlotKey {
			return m, nil
		}
	}
	return models.CliModelMapping{}, errors.New("settings: mapping write not visible")
}
func (r *BunSettingsRepository) DeleteCliMapping(ctx context.Context, t, s string) (bool, error) {
	if r == nil || r.db == nil {
		return false, ErrRepositoryClosed
	}
	res, err := r.db.NewRaw(`DELETE FROM cli_model_mappings WHERE tool_id=? AND slot_key=?`, boundedString(t, maxSettingsText), boundedString(s, maxSettingsText)).Exec(ctx)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}
func (r *BunSettingsRepository) GetCliMappingSettings(ctx context.Context, t string) (models.CliMappingSettings, error) {
	if r == nil || r.db == nil {
		return models.CliMappingSettings{}, ErrRepositoryClosed
	}
	var v cliSettingRow
	if err := r.db.NewSelect().Model(&v).Where("tool_id=?", boundedString(t, maxSettingsText)).Scan(ctx); err != nil {
		return models.CliMappingSettings{}, err
	}
	return models.CliMappingSettings{ToolID: v.ToolID, Enabled: v.Enabled, UpdatedAt: v.UpdatedAt}, nil
}
func (r *BunSettingsRepository) SetCliMappingEnabled(ctx context.Context, t string, e bool) (models.CliMappingSettings, error) {
	if r == nil || r.db == nil {
		return models.CliMappingSettings{}, ErrRepositoryClosed
	}
	t = strings.TrimSpace(t)
	if t == "" || len(t) > maxSettingsText {
		return models.CliMappingSettings{}, errors.New("settings: invalid CLI tool")
	}
	now := time.Now().UTC()
	_, err := r.db.NewRaw(`INSERT INTO cli_tool_mapping_settings(tool_id,enabled,updated_at) VALUES(?,?,?) ON CONFLICT(tool_id) DO UPDATE SET enabled=EXCLUDED.enabled,updated_at=EXCLUDED.updated_at`, t, e, now).Exec(ctx)
	if err != nil {
		return models.CliMappingSettings{}, err
	}
	return r.GetCliMappingSettings(ctx, t)
}
func (r *BunSettingsRepository) ResetCliMappings(ctx context.Context, t string) error {
	if r == nil || r.db == nil {
		return ErrRepositoryClosed
	}
	_, err := r.db.NewRaw(`DELETE FROM cli_model_mappings WHERE tool_id=?`, boundedString(t, maxSettingsText)).Exec(ctx)
	return err
}
func (r *BunSettingsRepository) ListFilterRules(ctx context.Context) ([]models.FilterRule, error) {
	if r == nil || r.db == nil {
		return nil, ErrRepositoryClosed
	}
	rows := []filterSettingsRow{}
	if err := r.db.NewSelect().Model(&rows).OrderExpr("sort_order ASC, id ASC").Limit(maxSettingsRows).Scan(ctx); err != nil {
		return nil, err
	}
	out := make([]models.FilterRule, len(rows))
	for i, v := range rows {
		out[i] = models.FilterRule{ID: v.ID, RuleID: v.RuleID, Pattern: v.Pattern, Replacement: v.Replacement, IsActive: v.IsActive, IsRegex: v.IsRegex, SortOrder: v.SortOrder, CreatedAt: v.CreatedAt, UpdatedAt: v.UpdatedAt}
	}
	return out, nil
}
func (r *BunSettingsRepository) UpsertFilterRule(ctx context.Context, v models.FilterRule) (models.FilterRule, error) {
	if r == nil || r.db == nil {
		return models.FilterRule{}, ErrRepositoryClosed
	}
	if strings.TrimSpace(v.RuleID) == "" || len(v.RuleID) > maxSettingsText || len(v.Pattern) > maxSettingsJSON || len(v.Replacement) > maxSettingsJSON {
		return models.FilterRule{}, errors.New("settings: invalid filter rule")
	}
	now := time.Now().UTC()
	if v.CreatedAt.IsZero() {
		v.CreatedAt = now
	}
	v.UpdatedAt = &now
	_, err := r.db.NewRaw(`INSERT INTO filter_rules(id,rule_id,pattern,replacement,is_active,is_regex,sort_order,created_at,updated_at) VALUES(NULLIF(?,0),?,?,?,?,?,?,?,?) ON CONFLICT(rule_id) DO UPDATE SET pattern=EXCLUDED.pattern,replacement=EXCLUDED.replacement,is_active=EXCLUDED.is_active,is_regex=EXCLUDED.is_regex,sort_order=EXCLUDED.sort_order,updated_at=EXCLUDED.updated_at`, v.ID, v.RuleID, v.Pattern, v.Replacement, v.IsActive, v.IsRegex, v.SortOrder, v.CreatedAt, v.UpdatedAt).Exec(ctx)
	if err != nil {
		return models.FilterRule{}, err
	}
	rows, err := r.ListFilterRules(ctx)
	if err != nil {
		return models.FilterRule{}, err
	}
	for _, x := range rows {
		if x.RuleID == v.RuleID {
			return x, nil
		}
	}
	return models.FilterRule{}, errors.New("settings: filter rule write not visible")
}
func (r *BunSettingsRepository) DeleteFilterRule(ctx context.Context, id int64) (bool, error) {
	if r == nil || r.db == nil {
		return false, ErrRepositoryClosed
	}
	if id <= 0 {
		return false, nil
	}
	res, err := r.db.NewRaw(`DELETE FROM filter_rules WHERE id=?`, id).Exec(ctx)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}
func settingsPair(a, b string) (string, string, error) {
	a = strings.TrimSpace(a)
	b = strings.TrimSpace(b)
	if a == "" || b == "" || len(a) > maxSettingsText || len(b) > maxSettingsText {
		return "", "", errors.New("settings: values are required and bounded")
	}
	return a, b, nil
}
func boundedString(v string, n int) string {
	v = strings.TrimSpace(v)
	if len(v) > n {
		return v[:n]
	}
	return v
}

var _ SettingsRepository = (*BunSettingsRepository)(nil)
