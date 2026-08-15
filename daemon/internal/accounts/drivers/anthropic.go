package drivers

// NewAnthropic constructs the Anthropic Claude OAuth driver with its provider
// defaults, while allowing callers to override transport and lifecycle config.
func NewAnthropic(cfg Config) (*HTTPDriver, error) {
	return New(mergeConfig(defaultConfig(ProviderClaude), cfg))
}

// NewAnthropicDefault constructs the Anthropic driver with default settings.
func NewAnthropicDefault() (*HTTPDriver, error) { return NewAnthropic(Config{}) }
