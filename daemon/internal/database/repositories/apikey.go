package repositories

import (
	"context"

	"github.com/cartethyia/daemon/internal/database/models"
)

// APIKeyRepository owns the api_keys and share_links tables.
//
// The Credential accessor returns the full secret; callers MUST NOT log
// the result. Touch/FlushTouches exist for the same coalesced-write
// pattern the legacy SQLite layer used on last_used_at.
type APIKeyRepository interface {
	List(ctx context.Context) ([]models.ApiKey, error)
	GetByID(ctx context.Context, id string) (models.ApiKey, error)
	GetBySecret(ctx context.Context, key string) (models.ApiKey, error)
	Credential(ctx context.Context, id string) (string, error)
	Create(ctx context.Context, input models.ApiKeyCreateInput) (models.ApiKey, error)
	Patch(ctx context.Context, id string, patch models.ApiKeyPatchInput) (models.ApiKey, error)
	Revoke(ctx context.Context, id string) (bool, error)
	Delete(ctx context.Context, id string) (bool, error)
	Touch(ctx context.Context, id string) error
	FlushTouches(ctx context.Context) error
	SumOneTimeTokensUsed(ctx context.Context, id string) (int, error)
	ConsumeOneTimeTokens(ctx context.Context, id string, tokens int) error

	CreateShareLink(ctx context.Context, link models.ShareLink) (models.ShareLink, error)
	GetShareLinkByTokenHash(ctx context.Context, tokenHash string) (models.ShareLink, error)
	ListShareLinksByAPIKey(ctx context.Context, apiKeyID string) ([]models.ShareLink, error)
	PatchShareLinkActive(ctx context.Context, id string, active bool) (models.ShareLink, error)
	ConsumeSetupShareLink(ctx context.Context, id string, now string) (models.ShareLink, error)
	TouchShareLink(ctx context.Context, id string) error
	DeleteShareLink(ctx context.Context, id string) (bool, error)
}
