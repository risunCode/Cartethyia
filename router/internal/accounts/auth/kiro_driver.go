package auth

// NewKiro constructs the Kiro driver with its AWS OIDC and social-login
// extensions while retaining the shared bounded HTTP behavior.
func NewKiro(cfg Config) (*KiroDriver, error) {
	cfg.ProviderID = ProviderKiro
	cfg.Kind = KindDevice
	driver, err := New(cfg)
	if err != nil {
		return nil, err
	}
	return &KiroDriver{HTTPDriver: driver}, nil
}

// NewKiroDefault constructs the Kiro driver with its provider defaults.
func NewKiroDefault() (*KiroDriver, error) {
	return NewKiro(defaultConfig(ProviderKiro))
}
