package kimchi

import "github.com/cartethyia/daemon/internal/accounts/drivers"

type Config = drivers.Config
type Driver = drivers.HTTPDriver

func New(cfg Config) (*Driver, error) { return drivers.NewKimchi(cfg) }
func NewDefault() (*Driver, error)    { return drivers.NewKimchi(Config{}) }
