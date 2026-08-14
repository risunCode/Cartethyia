package models

import "time"

// BackupTable is a logical table identifier accepted by backup
// export/restore. The constants mirror the legacy TS allowlist and are
// the only names a backup driver may interpolate into SQL.
type BackupTable string

const (
	BackupTableSettings           BackupTable = "settings"
	BackupTableAPIKeys            BackupTable = "api_keys"
	BackupTableModelAliases       BackupTable = "model_aliases"
	BackupTableCLIMappings        BackupTable = "cli_model_mappings"
	BackupTableCLIMappingSettings BackupTable = "cli_tool_mapping_settings"
	BackupTableCombos             BackupTable = "combos"
	BackupTableAccessRules        BackupTable = "access_rules"
	BackupTableProviderAccounts   BackupTable = "provider_accounts"
	BackupTableProviderModels     BackupTable = "provider_models"
	BackupTableCustomProviders    BackupTable = "custom_providers"
	BackupTableProxies            BackupTable = "proxies"
	BackupTableProxySettings      BackupTable = "proxy_settings"
	BackupTableFilterRules        BackupTable = "filter_rules"
	BackupTableIPBans             BackupTable = "ip_bans"
)

// BackupMetadata describes one persisted configuration backup
// (backup_metadata). The actual payload is stored at StoragePath; only the
// header lives in Postgres.
type BackupMetadata struct {
	ID            string
	CreatedAt     time.Time
	SizeBytes     int64
	SourceApp     string
	SourceVersion int
	Label         string
	StoragePath   string
	ContentHash   string
}

// BackupContent is a parsed backup archive ready for inspection or restore.
type BackupContent struct {
	Metadata BackupMetadata
	Tables   map[BackupTable][][]byte
}
