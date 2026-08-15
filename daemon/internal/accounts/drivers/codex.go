package drivers

// NewCodex constructs the ChatGPT Codex OAuth driver with provider defaults.
func NewCodex(cfg Config) (*HTTPDriver, error) {
	return New(mergeConfig(defaultConfig(ProviderCodex), cfg))
}

// NewCodexDefault constructs the Codex driver with default settings.
func NewCodexDefault() (*HTTPDriver, error) { return NewCodex(Config{}) }
