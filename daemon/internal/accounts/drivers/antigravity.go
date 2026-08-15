package drivers

// NewAntigravity constructs the Google Cloud Code Assist OAuth driver with
// provider defaults, while allowing callers to override lifecycle config.
func NewAntigravity(cfg Config) (*HTTPDriver, error) {
	return New(mergeConfig(defaultConfig(ProviderAntigravity), cfg))
}

// NewAntigravityDefault constructs the Antigravity driver with default settings.
func NewAntigravityDefault() (*HTTPDriver, error) { return NewAntigravity(Config{}) }
