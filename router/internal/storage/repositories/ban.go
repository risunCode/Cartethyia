package repositories

import (
	"context"

	"github.com/cartethyia/daemon/internal/storage/models"
)

// BanRepository owns the ip_bans and security_offenses tables.
//
// ip_bans is operator-managed and durable; security_offenses is a
// rolling-window counter intentionally excluded from backups.
type BanRepository interface {
	IsBanned(ctx context.Context, ip string) (bool, error)
	GetBan(ctx context.Context, ip string) (models.IPBan, error)
	ListBans(ctx context.Context) ([]models.IPBan, error)
	UpsertBan(ctx context.Context, ban models.IPBan) (models.IPBan, error)
	DeleteBan(ctx context.Context, ip string) (bool, error)

	IncrementOffense(ctx context.Context, ip, category string, now string) (models.SecurityOffense, error)
	ResetOffense(ctx context.Context, ip, category string) error
	ListOffenses(ctx context.Context, ip string) ([]models.SecurityOffense, error)
}
