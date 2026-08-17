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
	maxBanText = 256
	maxBanRows = 4096
)

// BunBanRepository owns durable operator bans and bounded rolling offense
// counters. IP/category/reason values are normalized and never used as SQL
// identifiers or interpolated fragments.
type BunBanRepository struct{ db *bun.DB }

func NewBunBanRepository(db *bun.DB) *BunBanRepository { return &BunBanRepository{db: db} }

type banRow struct {
	bun.BaseModel `bun:"table:ip_bans"`
	IP            string    `bun:"ip"`
	Reason        string    `bun:"reason"`
	CreatedAt     time.Time `bun:"created_at"`
}

type offenseRow struct {
	bun.BaseModel   `bun:"table:security_offenses"`
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
	if err := r.db.NewSelect().Model(&row).Where("ip=?", boundedString(ip, maxBanText)).Scan(ctx); err != nil {
		return models.IPBan{}, err
	}
	return models.IPBan{IP: row.IP, Reason: row.Reason, CreatedAt: row.CreatedAt}, nil
}
func (r *BunBanRepository) ListBans(ctx context.Context) ([]models.IPBan, error) {
	if r == nil || r.db == nil {
		return nil, ErrRepositoryClosed
	}
	rows := []banRow{}
	if err := r.db.NewSelect().Model(&rows).OrderExpr("created_at DESC, ip ASC").Limit(maxBanRows).Scan(ctx); err != nil {
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
	q := r.db.NewSelect().Model(&rows).Order("last_event_at DESC").Limit(maxBanRows)
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
	if err := r.db.NewSelect().Model(&row).Where("ip=? AND category=?", ip, category).Scan(ctx); err != nil {
		return models.SecurityOffense{}, fmt.Errorf("ban: read offense: %w", err)
	}
	return offenseModel(row), nil
}
func offenseModel(v offenseRow) models.SecurityOffense {
	return models.SecurityOffense{IP: v.IP, Category: v.Category, StrikeCount: v.StrikeCount, WindowStartedAt: v.WindowStartedAt, LastEventAt: v.LastEventAt}
}

var _ BanRepository = (*BunBanRepository)(nil)
