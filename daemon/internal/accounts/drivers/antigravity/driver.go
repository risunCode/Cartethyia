package antigravity

import "github.com/cartethyia/daemon/internal/accounts/drivers"

type Config = drivers.Config
type Driver = drivers.HTTPDriver

func New(cfg Config) (*Driver, error) { return drivers.NewAntigravity(cfg) }
func NewDefault() (*Driver, error)    { return drivers.NewAntigravity(Config{}) }
