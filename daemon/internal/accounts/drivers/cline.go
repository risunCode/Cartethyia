package drivers

// NewCline constructs the Cline device-flow driver with provider defaults.
func NewCline(cfg Config) (*HTTPDriver, error) {
	return New(mergeConfig(defaultConfig(ProviderCline), cfg))
}

// NewClineDefault constructs the Cline driver with default settings.
func NewClineDefault() (*HTTPDriver, error) { return NewCline(Config{}) }

// NewClinePass constructs the Cline Pass browser/device-flow driver.
func NewClinePass(cfg Config) (*HTTPDriver, error) {
	return New(mergeConfig(defaultConfig(ProviderClinePass), cfg))
}

// NewClinePassDefault constructs the Cline Pass driver with default settings.
func NewClinePassDefault() (*HTTPDriver, error) { return NewClinePass(Config{}) }
