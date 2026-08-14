package repositories

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"time"

	"github.com/cartethyia/daemon/internal/accounts"
	"github.com/cartethyia/daemon/internal/database/models"
	"github.com/uptrace/bun"
)

// BunAccountStores implements the durable account, token-record, and encrypted
// secret boundaries on one PostgreSQL handle. The encryption key is supplied
// by runtime configuration and is never persisted in PostgreSQL.
type BunAccountStores struct {
	db  *bun.DB
	key [32]byte
}

// NewBunAccountStores creates account stores. A key is mandatory because secret
// blobs must never be written in plaintext.
func NewBunAccountStores(db *bun.DB, encryptionKey []byte) (*BunAccountStores, error) {
	if db == nil {
		return nil, errors.New("accounts: PostgreSQL database is required")
	}
	if len(encryptionKey) < 16 {
		return nil, errors.New("accounts: encryption key must be at least 16 bytes")
	}
	return &BunAccountStores{db: db, key: sha256.Sum256(encryptionKey)}, nil
}

func (s *BunAccountStores) PutConfig(ctx context.Context, cfg *accounts.AccountConfig) error {
	if err := cfg.Validate(); err != nil {
		return err
	}
	labels, _ := json.Marshal(cfg.Labels)
	scopes, _ := json.Marshal(cfg.Scopes)
	_, err := s.db.NewRaw(`
INSERT INTO provider_accounts (id, provider, name, credential_kind, credential_ref, credential_hint, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())
ON CONFLICT (id) DO UPDATE SET provider=EXCLUDED.provider, credential_kind=EXCLUDED.credential_kind,
credential_ref=EXCLUDED.credential_ref, updated_at=EXCLUDED.updated_at`,
		cfg.ID, cfg.ProviderID, cfg.ID, string(cfg.Kind), cfg.CredentialRef.String(), "").Exec(ctx)
	if err != nil {
		return err
	}
	_, err = s.db.NewRaw(`
INSERT INTO account_configs (id, provider_id, kind, enabled, labels_json, credential_ref, oauth_client_id, redirect_uri, scopes_json, updated_at)
VALUES (?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?::jsonb, NOW())
ON CONFLICT (id) DO UPDATE SET provider_id=EXCLUDED.provider_id, kind=EXCLUDED.kind, enabled=EXCLUDED.enabled,
labels_json=EXCLUDED.labels_json, credential_ref=EXCLUDED.credential_ref, oauth_client_id=EXCLUDED.oauth_client_id,
redirect_uri=EXCLUDED.redirect_uri, scopes_json=EXCLUDED.scopes_json, updated_at=NOW()`,
		cfg.ID, cfg.ProviderID, string(cfg.Kind), cfg.Enabled, string(labels), cfg.CredentialRef.String(), cfg.OAuthClientID, cfg.RedirectURI, string(scopes)).Exec(ctx)
	return err
}

func (s *BunAccountStores) GetConfig(ctx context.Context, id string) (*accounts.AccountConfig, error) {
	var row accountConfigRow
	if err := s.db.NewRaw(`SELECT id, provider_id, kind, enabled, labels_json, credential_ref, oauth_client_id, redirect_uri, scopes_json FROM account_configs WHERE id = ?`, id).Scan(ctx, &row); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, accounts.ErrAccountNotFound
		}
		return nil, err
	}
	return row.config()
}

func (s *BunAccountStores) ListConfigs(ctx context.Context) ([]*accounts.AccountConfig, error) {
	rows := []accountConfigRow{}
	if err := s.db.NewRaw(`SELECT id, provider_id, kind, enabled, labels_json, credential_ref, oauth_client_id, redirect_uri, scopes_json FROM account_configs ORDER BY id`).Scan(ctx, &rows); err != nil {
		return nil, err
	}
	out := make([]*accounts.AccountConfig, 0, len(rows))
	for _, row := range rows {
		cfg, err := row.config()
		if err != nil {
			return nil, err
		}
		out = append(out, cfg)
	}
	return out, nil
}

// ListAccountDirectory returns enabled account configuration and non-secret
// token metadata in one provider-filtered query. Secret blobs are deliberately
// not selected; request-time material remains behind SecretStore.
func (s *BunAccountStores) ListAccountDirectory(ctx context.Context, providerID string) ([]accounts.AccountDirectoryEntry, error) {
	rows := []accountDirectoryRow{}
	if err := s.db.NewRaw(`
SELECT c.id AS config_id, c.provider_id AS config_provider_id, c.kind AS config_kind,
       c.enabled AS config_enabled, c.labels_json AS config_labels_json,
       c.credential_ref AS config_credential_ref, c.oauth_client_id AS config_oauth_client_id,
       c.redirect_uri AS config_redirect_uri, c.scopes_json AS config_scopes_json,
       COALESCE(r.account_id, '') AS record_account_id, COALESCE(r.provider_id, '') AS record_provider_id,
       COALESCE(r.kind, '') AS record_kind, COALESCE(r.origin, '') AS record_origin,
       COALESCE(r.access_fingerprint, '') AS record_access_fingerprint,
       COALESCE(r.refresh_fingerprint, '') AS record_refresh_fingerprint,
       COALESCE(r.expires_at, TIMESTAMP 'epoch') AS record_expires_at,
       COALESCE(r.scope, '') AS record_scope, COALESCE(r.provider_account_id, '') AS record_provider_account_id,
       COALESCE(r.email, '') AS record_email, COALESCE(r.org_id, '') AS record_org_id,
       COALESCE(r.org_name, '') AS record_org_name,
       COALESCE(r.issued_at, TIMESTAMP 'epoch') AS record_issued_at,
       COALESCE(r.reauthentication_required, FALSE) AS record_reauthentication_required,
       COALESCE(r.version, 0) AS record_version
FROM account_configs AS c
LEFT JOIN oauth_token_records AS r ON r.account_id = c.id
WHERE c.provider_id = ? AND c.enabled = TRUE
ORDER BY c.id`, providerID).Scan(ctx, &rows); err != nil {
		return nil, err
	}
	out := make([]accounts.AccountDirectoryEntry, 0, len(rows))
	for _, row := range rows {
		cfg, err := row.config()
		if err != nil {
			return nil, err
		}
		entry := accounts.AccountDirectoryEntry{Config: cfg}
		if row.RecordAccountID != "" {
			entry.Record = row.record()
		}
		out = append(out, entry)
	}
	return out, nil
}

// GetHealth reads the non-secret provider_account_health sidecar. Missing
// rows are represented by a healthy zero state so newly-created accounts do
// not require an eager health write.
func (s *BunAccountStores) GetHealth(ctx context.Context, accountID string) (models.AccountHealth, error) {
	var row models.AccountHealth
	err := s.db.NewRaw(`SELECT account_id, status, error_kind, status_code, sanitized_message, occurred_at, retry_at, last_refresh_at, quota_json, quota_error, quota_fetched_at, provider_id, disabled_until_ms, failure_count, generation, updated_at FROM provider_account_health WHERE account_id = ?`, accountID).Scan(ctx, &row)
	if errors.Is(err, sql.ErrNoRows) {
		return models.AccountHealth{AccountID: accountID, Status: "healthy", UpdatedAt: time.Now().UTC()}, nil
	}
	return row, err
}

func (s *BunAccountStores) UpsertHealth(ctx context.Context, health models.AccountHealth) error {
	if health.AccountID == "" {
		return errors.New("accounts: health account id is required")
	}
	if health.Status == "" {
		health.Status = "healthy"
	}
	if health.UpdatedAt.IsZero() {
		health.UpdatedAt = time.Now().UTC()
	}
	_, err := s.db.NewRaw(`
INSERT INTO provider_account_health (account_id, status, error_kind, status_code, sanitized_message, occurred_at, retry_at, last_refresh_at, quota_json, quota_error, quota_fetched_at, provider_id, disabled_until_ms, failure_count, generation, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (account_id) DO UPDATE SET status=EXCLUDED.status, error_kind=EXCLUDED.error_kind, status_code=EXCLUDED.status_code, sanitized_message=EXCLUDED.sanitized_message, occurred_at=EXCLUDED.occurred_at, retry_at=EXCLUDED.retry_at, last_refresh_at=EXCLUDED.last_refresh_at, quota_json=EXCLUDED.quota_json, quota_error=EXCLUDED.quota_error, quota_fetched_at=EXCLUDED.quota_fetched_at, provider_id=EXCLUDED.provider_id, disabled_until_ms=EXCLUDED.disabled_until_ms, failure_count=EXCLUDED.failure_count, generation=EXCLUDED.generation, updated_at=EXCLUDED.updated_at`,
		health.AccountID, health.Status, health.ErrorKind, health.StatusCode, health.SanitizedMessage, health.OccurredAt, health.RetryAt, health.LastRefreshAt, blobOrNil(health.QuotaJSON), health.QuotaError, health.QuotaFetchedAt, health.ProviderID, health.DisabledUntilMs, health.FailureCount, health.Generation, health.UpdatedAt).Exec(ctx)
	return err
}

func (s *BunAccountStores) GetModelLock(ctx context.Context, accountID, modelID string) (models.AccountModelLock, error) {
	var row models.AccountModelLock
	err := s.db.NewRaw(`SELECT account_id, model_id, retry_at, error_kind, status_code, sanitized_message, failure_count, created_at, updated_at FROM account_model_locks WHERE account_id = ? AND model_id = ?`, accountID, modelID).Scan(ctx, &row)
	if errors.Is(err, sql.ErrNoRows) {
		return models.AccountModelLock{AccountID: accountID, ModelID: modelID}, nil
	}
	return row, err
}

func (s *BunAccountStores) UpsertModelLock(ctx context.Context, lock models.AccountModelLock) error {
	if lock.AccountID == "" || lock.ModelID == "" {
		return errors.New("accounts: model lock account and model are required")
	}
	if lock.CreatedAt.IsZero() {
		lock.CreatedAt = time.Now().UTC()
	}
	if lock.UpdatedAt.IsZero() {
		lock.UpdatedAt = lock.CreatedAt
	}
	if lock.FailureCount <= 0 {
		lock.FailureCount = 1
	}
	_, err := s.db.NewRaw(`
INSERT INTO account_model_locks (account_id, model_id, retry_at, error_kind, status_code, sanitized_message, failure_count, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (account_id, model_id) DO UPDATE SET retry_at=EXCLUDED.retry_at, error_kind=EXCLUDED.error_kind, status_code=EXCLUDED.status_code, sanitized_message=EXCLUDED.sanitized_message, failure_count=EXCLUDED.failure_count, updated_at=EXCLUDED.updated_at`,
		lock.AccountID, lock.ModelID, lock.RetryAt, lock.ErrorKind, lock.StatusCode, lock.SanitizedMessage, lock.FailureCount, lock.CreatedAt, lock.UpdatedAt).Exec(ctx)
	return err
}

func (s *BunAccountStores) ClearModelLock(ctx context.Context, accountID, modelID string) error {
	_, err := s.db.NewRaw(`DELETE FROM account_model_locks WHERE account_id = ? AND model_id = ?`, accountID, modelID).Exec(ctx)
	return err
}

func (s *BunAccountStores) ClearModelLocks(ctx context.Context, accountID string) error {
	_, err := s.db.NewRaw(`DELETE FROM account_model_locks WHERE account_id = ?`, accountID).Exec(ctx)
	return err
}

func (s *BunAccountStores) DeleteAccount(ctx context.Context, id string) error {
	_, err := s.db.NewRaw(`DELETE FROM provider_accounts WHERE id = ?`, id).Exec(ctx)
	return err
}

func (s *BunAccountStores) PutAccess(ctx context.Context, id string, secret *accounts.Secret) error {
	return s.putSecret(ctx, id, secret, true)
}
func (s *BunAccountStores) PutRefresh(ctx context.Context, id string, secret *accounts.Secret) error {
	return s.putSecret(ctx, id, secret, false)
}

func (s *BunAccountStores) putSecret(ctx context.Context, id string, secret *accounts.Secret, access bool) error {
	if id == "" {
		return errors.New("accounts: account id is required")
	}
	var material []byte
	if secret != nil {
		material = secret.Reveal()
		secret.Close()
	}
	var blob []byte
	var err error
	if len(material) > 0 {
		blob, err = s.encrypt(material)
		clear(material)
	}
	if err != nil {
		return err
	}
	_, err = s.db.NewRaw(`INSERT INTO account_secret_blobs (account_id, key_version, version) VALUES (?, 1, 0) ON CONFLICT (account_id) DO NOTHING`, id).Exec(ctx)
	if err != nil {
		return err
	}
	column := "refresh_blob"
	if access {
		column = "access_blob"
	}
	_, err = s.db.NewRaw(`UPDATE account_secret_blobs SET `+column+` = ?, version = version + 1, updated_at = NOW() WHERE account_id = ?`, blobOrNil(blob), id).Exec(ctx)
	return err
}

func blobOrNil(blob []byte) any {
	if len(blob) == 0 {
		return nil
	}
	return blob
}

func (s *BunAccountStores) GetAccess(ctx context.Context, id string) (*accounts.Secret, error) {
	return s.getSecret(ctx, id, true)
}
func (s *BunAccountStores) GetRefresh(ctx context.Context, id string) (*accounts.Secret, error) {
	return s.getSecret(ctx, id, false)
}
func (s *BunAccountStores) getSecret(ctx context.Context, id string, access bool) (*accounts.Secret, error) {
	column := "refresh_blob"
	if access {
		column = "access_blob"
	}
	var blob []byte
	if err := s.db.NewRaw(`SELECT `+column+` FROM account_secret_blobs WHERE account_id = ?`, id).Scan(ctx, &blob); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, accounts.ErrSecretNotFound
		}
		return nil, err
	}
	if len(blob) == 0 {
		return nil, accounts.ErrSecretNotFound
	}
	material, err := s.decrypt(blob)
	if err != nil {
		return nil, err
	}
	return accounts.NewSecret(material), nil
}

func (s *BunAccountStores) DeleteSecrets(ctx context.Context, id string) error {
	_, err := s.db.NewRaw(`DELETE FROM account_secret_blobs WHERE account_id = ?`, id).Exec(ctx)
	return err
}
func (s *BunAccountStores) DeleteRecord(ctx context.Context, id string) error {
	_, err := s.db.NewRaw(`DELETE FROM oauth_token_records WHERE account_id = ?`, id).Exec(ctx)
	return err
}

func (s *BunAccountStores) PutRecord(ctx context.Context, record *accounts.OAuthTokenRecord) error {
	if record == nil || record.AccountID == "" {
		return errors.New("accounts: token record is required")
	}
	_, err := s.db.NewRaw(`INSERT INTO oauth_token_records
(account_id, provider_id, kind, origin, access_fingerprint, refresh_fingerprint, expires_at, scope, provider_account_id, email, org_id, org_name, issued_at, reauthentication_required, version, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
ON CONFLICT (account_id) DO UPDATE SET provider_id=EXCLUDED.provider_id, kind=EXCLUDED.kind, origin=EXCLUDED.origin,
access_fingerprint=EXCLUDED.access_fingerprint, refresh_fingerprint=EXCLUDED.refresh_fingerprint, expires_at=EXCLUDED.expires_at,
scope=EXCLUDED.scope, provider_account_id=EXCLUDED.provider_account_id, email=EXCLUDED.email, org_id=EXCLUDED.org_id,
org_name=EXCLUDED.org_name, issued_at=EXCLUDED.issued_at, reauthentication_required=EXCLUDED.reauthentication_required,
version=EXCLUDED.version, updated_at=NOW()`, record.AccountID, record.ProviderID, string(record.Kind), string(record.Origin), record.AccessFingerprint, record.RefreshFingerprint, record.ExpiresAt, record.Scope, record.ProviderAccountID, record.Email, record.OrgID, record.OrgName, record.IssuedAt, record.ReauthenticationRequired, record.Version).Exec(ctx)
	return err
}

func (s *BunAccountStores) GetRecord(ctx context.Context, id string) (*accounts.OAuthTokenRecord, error) {
	var row tokenRecordRow
	if err := s.db.NewRaw(`SELECT account_id, provider_id, kind, origin, access_fingerprint, refresh_fingerprint, expires_at, scope, provider_account_id, email, org_id, org_name, issued_at, reauthentication_required, version FROM oauth_token_records WHERE account_id = ?`, id).Scan(ctx, &row); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, accounts.ErrRecordNotFound
		}
		return nil, err
	}
	return row.record(), nil
}

func (s *BunAccountStores) ListRecords(ctx context.Context) ([]*accounts.OAuthTokenRecord, error) {
	rows := []tokenRecordRow{}
	if err := s.db.NewRaw(`SELECT account_id, provider_id, kind, origin, access_fingerprint, refresh_fingerprint, expires_at, scope, provider_account_id, email, org_id, org_name, issued_at, reauthentication_required, version FROM oauth_token_records ORDER BY account_id`).Scan(ctx, &rows); err != nil {
		return nil, err
	}
	out := make([]*accounts.OAuthTokenRecord, 0, len(rows))
	for _, row := range rows {
		out = append(out, row.record())
	}
	return out, nil
}

func (s *BunAccountStores) CompareAndSwap(ctx context.Context, expected int64, record *accounts.OAuthTokenRecord) error {
	if record == nil {
		return errors.New("accounts: token record is required")
	}
	result, err := s.db.NewRaw(`UPDATE oauth_token_records SET provider_id=?, kind=?, origin=?, access_fingerprint=?, refresh_fingerprint=?, expires_at=?, scope=?, provider_account_id=?, email=?, org_id=?, org_name=?, issued_at=?, reauthentication_required=?, version=version+1, updated_at=NOW() WHERE account_id=? AND version=?`, record.ProviderID, string(record.Kind), string(record.Origin), record.AccessFingerprint, record.RefreshFingerprint, record.ExpiresAt, record.Scope, record.ProviderAccountID, record.Email, record.OrgID, record.OrgName, record.IssuedAt, record.ReauthenticationRequired, record.AccountID, expected).Exec(ctx)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return accounts.ErrVersionMismatch
	}
	record.Version = expected + 1
	return nil
}

// CommitRefresh atomically fences the lease, record generation, and encrypted
// secret slots. It is the durable path used by refreshers that support the
// RefreshCommitter contract.
func (s *BunAccountStores) CommitRefresh(ctx context.Context, expectedVersion int64, fence accounts.RefreshFence, record *accounts.OAuthTokenRecord, access, refresh *accounts.Secret) error {
	if record == nil || record.AccountID == "" {
		return errors.New("accounts: refresh record is required")
	}
	accessBlob, err := s.secretBlob(access)
	if err != nil {
		return err
	}
	refreshBlob, err := s.secretBlob(refresh)
	if err != nil {
		return err
	}
	return s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		var owner string
		var generation int64
		var leaseUntil int64
		if err := tx.NewRaw(`SELECT owner_id, generation, lease_until_ms FROM oauth_refresh_leases WHERE account_id = ? FOR UPDATE`, record.AccountID).Scan(ctx, &owner, &generation, &leaseUntil); err != nil {
			return err
		}
		if owner != fence.OwnerID || generation != fence.Generation || leaseUntil <= time.Now().UnixMilli() {
			return errors.New("accounts: refresh lease fence rejected")
		}
		result, err := tx.NewRaw(`UPDATE oauth_token_records SET provider_id=?, kind=?, origin=?, access_fingerprint=?, refresh_fingerprint=?, expires_at=?, scope=?, provider_account_id=?, email=?, org_id=?, org_name=?, issued_at=?, reauthentication_required=?, version=version+1, updated_at=NOW() WHERE account_id=? AND version=?`, record.ProviderID, string(record.Kind), string(record.Origin), record.AccessFingerprint, record.RefreshFingerprint, record.ExpiresAt, record.Scope, record.ProviderAccountID, record.Email, record.OrgID, record.OrgName, record.IssuedAt, record.ReauthenticationRequired, record.AccountID, expectedVersion).Exec(ctx)
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if count != 1 {
			return accounts.ErrVersionMismatch
		}
		_, err = tx.NewRaw(`INSERT INTO account_secret_blobs (account_id, access_blob, refresh_blob, key_version, version, updated_at) VALUES (?, ?, ?, 1, 1, NOW()) ON CONFLICT (account_id) DO UPDATE SET access_blob=EXCLUDED.access_blob, refresh_blob=COALESCE(EXCLUDED.refresh_blob, account_secret_blobs.refresh_blob), version=account_secret_blobs.version+1, updated_at=NOW()`, record.AccountID, blobOrNil(accessBlob), blobOrNil(refreshBlob)).Exec(ctx)
		return err
	})
}

func (s *BunAccountStores) secretBlob(secret *accounts.Secret) ([]byte, error) {
	if secret == nil || secret.IsZero() {
		return nil, nil
	}
	material := secret.Reveal()
	defer secret.Close()
	encrypted, err := s.encrypt(material)
	clear(material)
	return encrypted, err
}

func (s *BunAccountStores) encrypt(plain []byte) ([]byte, error) {
	block, err := aes.NewCipher(s.key[:])
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return gcm.Seal(nonce, nonce, plain, nil), nil
}
func (s *BunAccountStores) decrypt(blob []byte) ([]byte, error) {
	block, err := aes.NewCipher(s.key[:])
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(blob) < gcm.NonceSize() {
		return nil, errors.New("accounts: encrypted secret blob is truncated")
	}
	return gcm.Open(nil, blob[:gcm.NonceSize()], blob[gcm.NonceSize():], nil)
}

type accountConfigRow struct {
	ID, ProviderID, Kind                                      string
	Enabled                                                   bool
	Labels, CredentialRef, OAuthClientID, RedirectURI, Scopes []byte
}

type accountDirectoryRow struct {
	ConfigID                       string    `bun:"config_id"`
	ConfigProviderID               string    `bun:"config_provider_id"`
	ConfigKind                     string    `bun:"config_kind"`
	ConfigEnabled                  bool      `bun:"config_enabled"`
	ConfigLabelsJSON               []byte    `bun:"config_labels_json"`
	ConfigCredentialRef            []byte    `bun:"config_credential_ref"`
	ConfigOAuthClientID            []byte    `bun:"config_oauth_client_id"`
	ConfigRedirectURI              []byte    `bun:"config_redirect_uri"`
	ConfigScopesJSON               []byte    `bun:"config_scopes_json"`
	RecordAccountID                string    `bun:"record_account_id"`
	RecordProviderID               string    `bun:"record_provider_id"`
	RecordKind                     string    `bun:"record_kind"`
	RecordOrigin                   string    `bun:"record_origin"`
	RecordAccessFingerprint        string    `bun:"record_access_fingerprint"`
	RecordRefreshFingerprint       string    `bun:"record_refresh_fingerprint"`
	RecordScope                    string    `bun:"record_scope"`
	RecordProviderAccountID        string    `bun:"record_provider_account_id"`
	RecordEmail                    string    `bun:"record_email"`
	RecordOrgID                    string    `bun:"record_org_id"`
	RecordOrgName                  string    `bun:"record_org_name"`
	RecordExpiresAt                time.Time `bun:"record_expires_at"`
	RecordIssuedAt                 time.Time `bun:"record_issued_at"`
	RecordReauthenticationRequired bool      `bun:"record_reauthentication_required"`
	RecordVersion                  int64     `bun:"record_version"`
}

func (r accountDirectoryRow) config() (*accounts.AccountConfig, error) {
	return (accountConfigRow{
		ID: r.ConfigID, ProviderID: r.ConfigProviderID, Kind: r.ConfigKind,
		Enabled: r.ConfigEnabled, Labels: r.ConfigLabelsJSON,
		CredentialRef: r.ConfigCredentialRef, OAuthClientID: r.ConfigOAuthClientID,
		RedirectURI: r.ConfigRedirectURI, Scopes: r.ConfigScopesJSON,
	}).config()
}

func (r accountDirectoryRow) record() *accounts.OAuthTokenRecord {
	return (tokenRecordRow{
		AccountID: r.RecordAccountID, ProviderID: r.RecordProviderID,
		Kind: r.RecordKind, Origin: r.RecordOrigin,
		AccessFingerprint:  r.RecordAccessFingerprint,
		RefreshFingerprint: r.RecordRefreshFingerprint, ExpiresAt: r.RecordExpiresAt,
		Scope: r.RecordScope, ProviderAccountID: r.RecordProviderAccountID,
		Email: r.RecordEmail, OrgID: r.RecordOrgID, OrgName: r.RecordOrgName,
		IssuedAt: r.RecordIssuedAt, ReauthenticationRequired: r.RecordReauthenticationRequired,
		Version: r.RecordVersion,
	}).record()
}

func (r accountConfigRow) config() (*accounts.AccountConfig, error) {
	var labels map[string]string
	var scopes []string
	if err := json.Unmarshal(r.Labels, &labels); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(r.Scopes, &scopes); err != nil {
		return nil, err
	}
	ref, err := accounts.NewReference(string(r.CredentialRef))
	if err != nil && len(r.CredentialRef) > 0 {
		return nil, err
	}
	return &accounts.AccountConfig{ID: r.ID, ProviderID: r.ProviderID, Kind: accounts.CredentialKind(r.Kind), Enabled: r.Enabled, Labels: labels, CredentialRef: ref, OAuthClientID: string(r.OAuthClientID), RedirectURI: string(r.RedirectURI), Scopes: scopes}, nil
}

type tokenRecordRow struct {
	AccountID, ProviderID, Kind, Origin, AccessFingerprint, RefreshFingerprint, Scope, ProviderAccountID, Email, OrgID, OrgName string
	ExpiresAt, IssuedAt                                                                                                         time.Time
	ReauthenticationRequired                                                                                                    bool
	Version                                                                                                                     int64
}

func (r tokenRecordRow) record() *accounts.OAuthTokenRecord {
	return &accounts.OAuthTokenRecord{AccountID: r.AccountID, ProviderID: r.ProviderID, Kind: accounts.CredentialKind(r.Kind), Origin: accounts.CredentialOrigin(r.Origin), AccessFingerprint: r.AccessFingerprint, RefreshFingerprint: r.RefreshFingerprint, ExpiresAt: r.ExpiresAt, Scope: r.Scope, ProviderAccountID: r.ProviderAccountID, Email: r.Email, OrgID: r.OrgID, OrgName: r.OrgName, IssuedAt: r.IssuedAt, ReauthenticationRequired: r.ReauthenticationRequired, Version: r.Version}
}

type BunAccountConfigStore struct{ *BunAccountStores }
type BunSecretStore struct{ *BunAccountStores }
type BunRecordStore struct{ *BunAccountStores }

func (s *BunAccountConfigStore) Put(ctx context.Context, cfg *accounts.AccountConfig) error {
	return s.PutConfig(ctx, cfg)
}
func (s *BunAccountConfigStore) Get(ctx context.Context, id string) (*accounts.AccountConfig, error) {
	return s.GetConfig(ctx, id)
}
func (s *BunAccountConfigStore) List(ctx context.Context) ([]*accounts.AccountConfig, error) {
	return s.ListConfigs(ctx)
}
func (s *BunAccountConfigStore) Delete(ctx context.Context, id string) error {
	return s.DeleteAccount(ctx, id)
}
func (s *BunSecretStore) Delete(ctx context.Context, id string) error {
	return s.DeleteSecrets(ctx, id)
}
func (s *BunRecordStore) Put(ctx context.Context, record *accounts.OAuthTokenRecord) error {
	return s.PutRecord(ctx, record)
}
func (s *BunRecordStore) Get(ctx context.Context, id string) (*accounts.OAuthTokenRecord, error) {
	return s.GetRecord(ctx, id)
}
func (s *BunRecordStore) Delete(ctx context.Context, id string) error { return s.DeleteRecord(ctx, id) }
func (s *BunRecordStore) List(ctx context.Context) ([]*accounts.OAuthTokenRecord, error) {
	return s.ListRecords(ctx)
}
func (s *BunRecordStore) CommitRefresh(ctx context.Context, expectedVersion int64, fence accounts.RefreshFence, record *accounts.OAuthTokenRecord, access, refresh *accounts.Secret) error {
	return s.BunAccountStores.CommitRefresh(ctx, expectedVersion, fence, record, access, refresh)
}

var _ accounts.AccountConfigStore = (*BunAccountConfigStore)(nil)
var _ accounts.AccountDirectoryStore = (*BunAccountConfigStore)(nil)
var _ accounts.SecretStore = (*BunSecretStore)(nil)
var _ accounts.RecordStore = (*BunRecordStore)(nil)
var _ accounts.RefreshCommitter = (*BunAccountStores)(nil)
var _ accounts.RefreshCommitter = (*BunRecordStore)(nil)
