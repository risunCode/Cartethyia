package models

import "time"

// Settings is the singleton operator/configuration record (settings).
type Settings struct {
	PasswordHash    string
	PasswordVersion int
	JWTSecret       string
	SettingsJSON    []byte
	InitializedAt   time.Time
	UpdatedAt       time.Time
}

// ModelAlias is a friendly-name → upstream-model rewrite (model_aliases).
type ModelAlias struct {
	Alias     string
	Model     string
	CreatedAt time.Time
}

// Combo is a fallback/strategy fanout of model ids (combos).
type Combo struct {
	ID          string
	Name        string
	Models      []string
	Strategy    string
	StickyLimit int
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

// AccessRule is a per-scope allow/deny configuration (access_rules).
type AccessRule struct {
	Scope     string
	Mode      string
	Entries   []byte
	UpdatedAt time.Time
}

// ProviderModel is the (provider, model_id) availability row
// (provider_models).
type ProviderModel struct {
	Provider  string
	ModelID   string
	Enabled   bool
	Source    string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// CliMappingSettings records whether a CLI tool participates in model
// mapping (cli_tool_mapping_settings).
type CliMappingSettings struct {
	ToolID    string
	Enabled   bool
	UpdatedAt time.Time
}

// CliModelMapping rewrites a source model to a target model per CLI tool
// slot (cli_model_mappings).
type CliModelMapping struct {
	ToolID      string
	SlotKey     string
	SourceModel string
	TargetModel string
	Enabled     bool
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

// FilterRule rewrites request text fragments before they reach providers
// (filter_rules).
type FilterRule struct {
	ID          int64
	RuleID      string
	Pattern     string
	Replacement string
	IsActive    bool
	IsRegex     bool
	SortOrder   int
	CreatedAt   time.Time
	UpdatedAt   *time.Time
}
