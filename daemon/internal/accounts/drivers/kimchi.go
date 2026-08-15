package drivers

// NewKimchi constructs the Kimchi access-only OAuth driver with provider
// defaults.
func NewKimchi(cfg Config) (*HTTPDriver, error) {
	return New(mergeConfig(defaultConfig(ProviderKimchi), cfg))
}

// NewKimchiDefault constructs the Kimchi driver with default settings.
func NewKimchiDefault() (*HTTPDriver, error) { return NewKimchi(Config{}) }
