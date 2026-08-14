package kiro

import "github.com/cartethyia/daemon/internal/accounts/drivers"

type Config = drivers.Config
type Driver = drivers.KiroDriver

func New(cfg Config) (*Driver, error) { return drivers.NewKiro(cfg) }
func NewDefault() (*Driver, error)    { return drivers.NewKiro(Config{}) }
