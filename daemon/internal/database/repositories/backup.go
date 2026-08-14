package repositories

import (
	"context"

	"github.com/cartethyia/daemon/internal/database/models"
)

// BackupRepository owns the backup_metadata table. The exported payload
// itself (settings/api_keys/proxies/etc.) is a separate concern that the
// backup subsystem assembles from the other repositories; this interface
// only owns the persistent index of backups.
type BackupRepository interface {
	Insert(ctx context.Context, meta models.BackupMetadata) (models.BackupMetadata, error)
	Get(ctx context.Context, id string) (models.BackupMetadata, error)
	List(ctx context.Context) ([]models.BackupMetadata, error)
	ListOlderThan(ctx context.Context, cutoff string) ([]models.BackupMetadata, error)
	Delete(ctx context.Context, id string) (bool, error)
	DeleteOlderThan(ctx context.Context, cutoff string) (int64, error)
}
