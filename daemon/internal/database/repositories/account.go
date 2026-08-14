package repositories

import (
	"context"

	"github.com/cartethyia/daemon/internal/database/models"
)

// AccountRepository owns the provider_accounts sidecars.
//
// The list/listPaged pair supports both bulk hot-path reads
// (provider routing) and paged admin views. Get, Create, Patch and the
// delete/setActive batch helpers are the mutation surface. Credentials
// are kept out of the model returned by Get/List; callers fetch them via
// ListActiveCredentials or a dedicated credential accessor at the
// implementation layer.
type AccountRepository interface {
	List(ctx context.Context, provider string) ([]models.Account, error)
	ListPaged(ctx context.Context, provider string, pagination models.AccountListPagination) (models.AccountListPage, error)
	Get(ctx context.Context, id string) (models.Account, error)
	Create(ctx context.Context, input models.AccountCreateInput) (models.Account, error)
	Patch(ctx context.Context, id string, patch models.AccountPatchInput) (models.Account, error)
	Delete(ctx context.Context, id string) (bool, error)
	DeleteBatch(ctx context.Context, ids []string) (int, error)
	SetActiveBatch(ctx context.Context, ids []string, active bool) (int, error)
	ListActiveCredentials(ctx context.Context, provider string) ([]string, error)
	// Health returns the provider_account_health sidecar for one account.
	GetHealth(ctx context.Context, accountID string) (models.AccountHealth, error)
	// UpsertHealth replaces the provider_account_health row for an account.
	UpsertHealth(ctx context.Context, health models.AccountHealth) error
	// UpsertModelLock replaces the (account, model) cooldown row.
	UpsertModelLock(ctx context.Context, lock models.AccountModelLock) error
	// ClearModelLock removes the (account, model) cooldown row.
	ClearModelLock(ctx context.Context, accountID, modelID string) error
	// AcquireOAuthLease tries to obtain a refresh lease for an account. The
	// implementation MUST respect lease_until_ms and reject stale leases.
	AcquireOAuthLease(ctx context.Context, lease models.OAuthRefreshLease) (bool, error)
	// ReleaseOAuthLease clears the lease for the given account.
	ReleaseOAuthLease(ctx context.Context, accountID string) error
}
