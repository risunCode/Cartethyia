package runtime

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/cartethyia/daemon/internal/database/models"
	"github.com/cartethyia/daemon/internal/database/repositories"
	"golang.org/x/crypto/bcrypt"
)

// adminAPIKeyLister exposes only the subset of the API key repository the
// seeder needs to determine whether the dashboard already has an admin
// identity and to insert one when missing. Defining it here keeps the
// seeding code decoupled from any future methods on the durable repository
// and lets the tests substitute an in-memory implementation.
type adminAPIKeyLister interface {
	List(ctx context.Context) ([]models.ApiKey, error)
	Create(ctx context.Context, v models.ApiKeyCreateInput) (models.ApiKey, error)
}

// adminKeyName is the operator-readable label used to detect (and create)
// the bootstrap admin identity. Re-using the existing api_keys table keeps
// the seeder aligned with the durable authority without introducing a new
// store.
const adminKeyName = "admin"

// seedAdminCredentials creates the initial admin API key from the bootstrap
// password when no admin key already exists. The dashboard can therefore be
// brought up on first boot from CONSOLE_PASSWORD without manual
// database intervention. Existing keys take precedence: re-running the
// seeder never overwrites a stored credential, so an operator who rotates
// the password through the dashboard is not clobbered on the next restart.
func seedAdminCredentials(ctx context.Context, store *repositories.BunAPIKeyRepository, password string, logger *slog.Logger) error {
	return seedAdminCredentialsWith(ctx, store, password, logger)
}

// seedAdminCredentialsWith is the testable form of seedAdminCredentials. It
// accepts any adminAPIKeyLister so unit tests can supply an in-memory store
// without standing up the durable PostgreSQL adapter.
func seedAdminCredentialsWith(ctx context.Context, store adminAPIKeyLister, password string, logger *slog.Logger) error {
	if logger == nil {
		logger = slog.Default()
	}
	if store == nil {
		return errors.New("seed admin credentials: api key store is nil")
	}
	existing, err := store.List(ctx)
	if err != nil {
		return fmt.Errorf("seed admin credentials: list api keys: %w", err)
	}
	for _, k := range existing {
		if strings.EqualFold(strings.TrimSpace(k.Name), adminKeyName) {
			logger.Info("admin credentials already seeded, skipping")
			return nil
		}
	}
	if strings.TrimSpace(password) == "" {
		logger.Warn("CONSOLE_PASSWORD not set; no admin credentials created (dev mode only)")
		return nil
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("seed admin credentials: hash password: %w", err)
	}
	input := models.ApiKeyCreateInput{
		ID:        adminKeyName,
		Name:      adminKeyName,
		Key:       string(hash),
		KeyPrefix: adminKeyName,
	}
	if _, err := store.Create(ctx, input); err != nil {
		return fmt.Errorf("seed admin credentials: create admin key: %w", err)
	}
	logger.Info("admin credentials seeded from CONSOLE_PASSWORD")
	return nil
}
