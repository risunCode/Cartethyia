package repositories

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/cartethyia/daemon/internal/database/models"
	"github.com/uptrace/bun"
)

const (
	maxBackupText = 512
	maxBackupRows = 2048
	maxBanText    = 256
	maxBanRows    = 4096
)

// BunBackupRepository persists only backup metadata. Archive bytes remain in
// the configured backup storage path and are never serialized through admin
// metadata responses.
type BunBackupRepository struct{ db *bun.DB }

func NewBunBackupRepository(db *bun.DB) *BunBackupRepository { return &BunBackupRepository{db: db} }

type backupMetadataRow struct {
	ID            string    `bun:"id"`
	CreatedAt     time.Time `bun:"created_at"`
	SizeBytes     int64     `bun:"size_bytes"`
	SourceApp     string    `bun:"source_app"`
	SourceVersion int       `bun:"source_version"`
	Label         string    `bun:"label"`
	StoragePath   string    `bun:"storage_path"`
	ContentHash   string    `bun:"content_hash"`
}

func (r *BunBackupRepository) Insert(ctx context.Context, v models.BackupMetadata) (models.BackupMetadata, error) {
	if r == nil || r.db == nil {
		return models.BackupMetadata{}, ErrRepositoryClosed
	}
	if err := validateBackup(v); err != nil {
		return models.BackupMetadata{}, err
	}
	if v.CreatedAt.IsZero() {
		v.CreatedAt = time.Now().UTC()
	}
	row := backupMetadataRow{ID: v.ID, CreatedAt: v.CreatedAt, SizeBytes: v.SizeBytes, SourceApp: v.SourceApp, SourceVersion: v.SourceVersion, Label: v.Label, StoragePath: v.StoragePath, ContentHash: v.ContentHash}
	if _, err := r.db.NewInsert().Model(&row).Table("backup_metadata").Returning("*").Exec(ctx); err != nil {
		return models.BackupMetadata{}, err
	}
	return backupModel(row), nil
}
func (r *BunBackupRepository) Get(ctx context.Context, id string) (models.BackupMetadata, error) {
	if r == nil || r.db == nil {
		return models.BackupMetadata{}, ErrRepositoryClosed
	}
	var row backupMetadataRow
	if err := r.db.NewSelect().Model(&row).Table("backup_metadata").Where("id=?", boundedString(id, maxBackupText)).Scan(ctx); err != nil {
		return models.BackupMetadata{}, err
	}
	return backupModel(row), nil
}
func (r *BunBackupRepository) List(ctx context.Context) ([]models.BackupMetadata, error) {
	if r == nil || r.db == nil {
		return nil, ErrRepositoryClosed
	}
	rows := []backupMetadataRow{}
	if err := r.db.NewSelect().Model(&rows).Table("backup_metadata").Order("created_at DESC,id DESC").Limit(maxBackupRows).Scan(ctx); err != nil {
		return nil, err
	}
	out := make([]models.BackupMetadata, len(rows))
	for i, v := range rows {
		out[i] = backupModel(v)
	}
	return out, nil
}
func (r *BunBackupRepository) ListOlderThan(ctx context.Context, cutoff string) ([]models.BackupMetadata, error) {
	if r == nil || r.db == nil {
		return nil, ErrRepositoryClosed
	}
	cutoff = strings.TrimSpace(cutoff)
	if cutoff == "" || len(cutoff) > maxBackupText {
		return nil, errors.New("backup: cutoff is required and bounded")
	}
	rows := []backupMetadataRow{}
	if err := r.db.NewSelect().Model(&rows).Table("backup_metadata").Where("created_at < ?", cutoff).Order("created_at ASC,id ASC").Limit(maxBackupRows).Scan(ctx); err != nil {
		return nil, err
	}
	out := make([]models.BackupMetadata, len(rows))
	for i, v := range rows {
		out[i] = backupModel(v)
	}
	return out, nil
}
func (r *BunBackupRepository) Delete(ctx context.Context, id string) (bool, error) {
	if r == nil || r.db == nil {
		return false, ErrRepositoryClosed
	}
	res, err := r.db.NewRaw(`DELETE FROM backup_metadata WHERE id=?`, boundedString(id, maxBackupText)).Exec(ctx)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}
func (r *BunBackupRepository) DeleteOlderThan(ctx context.Context, cutoff string) (int64, error) {
	if r == nil || r.db == nil {
		return 0, ErrRepositoryClosed
	}
	cutoff = strings.TrimSpace(cutoff)
	if cutoff == "" || len(cutoff) > maxBackupText {
		return 0, errors.New("backup: cutoff is required and bounded")
	}
	res, err := r.db.NewRaw(`DELETE FROM backup_metadata WHERE created_at < ?`, cutoff).Exec(ctx)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
func validateBackup(v models.BackupMetadata) error {
	if strings.TrimSpace(v.ID) == "" || len(v.ID) > maxBackupText || strings.TrimSpace(v.SourceApp) == "" || len(v.SourceApp) > maxBackupText || v.SizeBytes < 0 || len(v.Label) > maxBackupText || strings.TrimSpace(v.StoragePath) == "" || len(v.StoragePath) > maxBackupText || len(v.ContentHash) > maxBackupText {
		return errors.New("backup: invalid metadata")
	}
	return nil
}
func backupModel(v backupMetadataRow) models.BackupMetadata {
	return models.BackupMetadata{ID: v.ID, CreatedAt: v.CreatedAt, SizeBytes: v.SizeBytes, SourceApp: v.SourceApp, SourceVersion: v.SourceVersion, Label: v.Label, StoragePath: v.StoragePath, ContentHash: v.ContentHash}
}

var _ BackupRepository = (*BunBackupRepository)(nil)

// BunBanRepository owns durable operator bans and bounded rolling offense
// counters. IP/category/reason values are normalized and never used as SQL
// identifiers or interpolated fragments.
type BunBanRepository struct{ db *bun.DB }

func NewBunBanRepository(db *bun.DB) *BunBanRepository { return &BunBanRepository{db: db} }

type banRow struct {
	IP        string    `bun:"ip"`
	Reason    string    `bun:"reason"`
	CreatedAt time.Time `bun:"created_at"`
}
type offenseRow struct {
	IP              string    `bun:"ip"`
	Category        string    `bun:"category"`
	StrikeCount     int       `bun:"strike_count"`
	WindowStartedAt time.Time `bun:"window_started_at"`
	LastEventAt     time.Time `bun:"last_event_at"`
}

func (r *BunBanRepository) IsBanned(ctx context.Context, ip string) (bool, error) {
	if r == nil || r.db == nil {
		return false, ErrRepositoryClosed
	}
	var exists bool
	if err := r.db.NewRaw(`SELECT EXISTS (SELECT 1 FROM ip_bans WHERE ip=?)`, boundedString(ip, maxBanText)).Scan(ctx, &exists); err != nil {
		return false, err
	}
	return exists, nil
}
func (r *BunBanRepository) GetBan(ctx context.Context, ip string) (models.IPBan, error) {
	if r == nil || r.db == nil {
		return models.IPBan{}, ErrRepositoryClosed
	}
	var row banRow
	if err := r.db.NewSelect().Model(&row).Table("ip_bans").Where("ip=?", boundedString(ip, maxBanText)).Scan(ctx); err != nil {
		return models.IPBan{}, err
	}
	return models.IPBan{IP: row.IP, Reason: row.Reason, CreatedAt: row.CreatedAt}, nil
}
func (r *BunBanRepository) ListBans(ctx context.Context) ([]models.IPBan, error) {
	if r == nil || r.db == nil {
		return nil, ErrRepositoryClosed
	}
	rows := []banRow{}
	if err := r.db.NewSelect().Model(&rows).Table("ip_bans").Order("created_at DESC,ip ASC").Limit(maxBanRows).Scan(ctx); err != nil {
		return nil, err
	}
	out := make([]models.IPBan, len(rows))
	for i, v := range rows {
		out[i] = models.IPBan{IP: v.IP, Reason: v.Reason, CreatedAt: v.CreatedAt}
	}
	return out, nil
}
func (r *BunBanRepository) UpsertBan(ctx context.Context, v models.IPBan) (models.IPBan, error) {
	if r == nil || r.db == nil {
		return models.IPBan{}, ErrRepositoryClosed
	}
	v.IP = strings.TrimSpace(v.IP)
	v.Reason = strings.TrimSpace(v.Reason)
	if v.IP == "" || len(v.IP) > maxBanText || len(v.Reason) > maxBanText {
		return models.IPBan{}, errors.New("ban: invalid IP or reason")
	}
	if v.CreatedAt.IsZero() {
		v.CreatedAt = time.Now().UTC()
	}
	if _, err := r.db.NewRaw(`INSERT INTO ip_bans(ip,reason,created_at) VALUES(?,?,?) ON CONFLICT(ip) DO UPDATE SET reason=EXCLUDED.reason`, v.IP, v.Reason, v.CreatedAt).Exec(ctx); err != nil {
		return models.IPBan{}, err
	}
	return r.GetBan(ctx, v.IP)
}
func (r *BunBanRepository) DeleteBan(ctx context.Context, ip string) (bool, error) {
	if r == nil || r.db == nil {
		return false, ErrRepositoryClosed
	}
	res, err := r.db.NewRaw(`DELETE FROM ip_bans WHERE ip=?`, boundedString(ip, maxBanText)).Exec(ctx)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}
func (r *BunBanRepository) IncrementOffense(ctx context.Context, ip, category, now string) (models.SecurityOffense, error) {
	if r == nil || r.db == nil {
		return models.SecurityOffense{}, ErrRepositoryClosed
	}
	ip = strings.TrimSpace(ip)
	category = strings.TrimSpace(category)
	now = strings.TrimSpace(now)
	if ip == "" || category == "" || len(ip) > maxBanText || len(category) > maxBanText || now == "" || len(now) > maxBanText {
		return models.SecurityOffense{}, errors.New("ban: invalid offense key or timestamp")
	}
	_, err := r.db.NewRaw(`INSERT INTO security_offenses(ip,category,strike_count,window_started_at,last_event_at) VALUES(?,?,1,?,?) ON CONFLICT(ip,category) DO UPDATE SET strike_count=security_offenses.strike_count+1,last_event_at=EXCLUDED.last_event_at`, ip, category, now, now).Exec(ctx)
	if err != nil {
		return models.SecurityOffense{}, err
	}
	return r.offense(ctx, ip, category)
}
func (r *BunBanRepository) ResetOffense(ctx context.Context, ip, category string) error {
	if r == nil || r.db == nil {
		return ErrRepositoryClosed
	}
	_, err := r.db.NewRaw(`DELETE FROM security_offenses WHERE ip=? AND category=?`, boundedString(ip, maxBanText), boundedString(category, maxBanText)).Exec(ctx)
	return err
}
func (r *BunBanRepository) ListOffenses(ctx context.Context, ip string) ([]models.SecurityOffense, error) {
	if r == nil || r.db == nil {
		return nil, ErrRepositoryClosed
	}
	rows := []offenseRow{}
	q := r.db.NewSelect().Model(&rows).Table("security_offenses").Order("last_event_at DESC").Limit(maxBanRows)
	if ip = strings.TrimSpace(ip); ip != "" {
		q = q.Where("ip=?", boundedString(ip, maxBanText))
	}
	if err := q.Scan(ctx); err != nil {
		return nil, err
	}
	out := make([]models.SecurityOffense, len(rows))
	for i, v := range rows {
		out[i] = offenseModel(v)
	}
	return out, nil
}
func (r *BunBanRepository) offense(ctx context.Context, ip, category string) (models.SecurityOffense, error) {
	var row offenseRow
	if err := r.db.NewSelect().Model(&row).Table("security_offenses").Where("ip=? AND category=?", ip, category).Scan(ctx); err != nil {
		return models.SecurityOffense{}, fmt.Errorf("ban: read offense: %w", err)
	}
	return offenseModel(row), nil
}
func offenseModel(v offenseRow) models.SecurityOffense {
	return models.SecurityOffense{IP: v.IP, Category: v.Category, StrikeCount: v.StrikeCount, WindowStartedAt: v.WindowStartedAt, LastEventAt: v.LastEventAt}
}

var _ BanRepository = (*BunBanRepository)(nil)
