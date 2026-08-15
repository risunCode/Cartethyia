package drivers

import (
	"github.com/cartethyia/daemon/internal/accounts"
)

// NewKiro constructs the Kiro driver with its AWS OIDC and social-login
// defaults, while allowing callers to override lifecycle config.
func NewKiro(cfg Config) (*KiroDriver, error) {
	return NewKiroDriver(mergeConfig(defaultConfig(ProviderKiro), cfg))
}

// NewKiroDefault constructs the Kiro driver with default settings.
func NewKiroDefault() (*KiroDriver, error) { return NewKiro(Config{}) }

// NewKiroDriver wraps the bounded provider-neutral HTTP lifecycle with Kiro's
// AWS OIDC and social-login wire formats.
func NewKiroDriver(cfg Config) (*KiroDriver, error) {
	base, err := New(cfg)
	if err != nil {
		return nil, err
	}
	return &KiroDriver{HTTPDriver: base}, nil
}

// Keep the account contract visible at this provider boundary. KiroDriver
// implements the shared AuthDriver contract through HTTPDriver promotion.
var _ accounts.AuthDriver = (*KiroDriver)(nil)
