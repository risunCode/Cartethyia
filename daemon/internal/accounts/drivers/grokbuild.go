package drivers

// NewGrokBuild constructs the Grok Build OAuth driver with provider defaults.
func NewGrokBuild(cfg Config) (*HTTPDriver, error) {
	return New(mergeConfig(defaultConfig(ProviderGrokBuild), cfg))
}

// NewGrokBuildDefault constructs the Grok Build driver with default settings.
func NewGrokBuildDefault() (*HTTPDriver, error) { return NewGrokBuild(Config{}) }
