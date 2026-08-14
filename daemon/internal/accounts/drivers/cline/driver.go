package cline

import "github.com/cartethyia/daemon/internal/accounts/drivers"

type Config = drivers.Config
type Driver = drivers.HTTPDriver

func New(cfg Config) (*Driver, error)     { return drivers.NewCline(cfg) }
func NewDefault() (*Driver, error)        { return drivers.NewCline(Config{}) }
func NewPass(cfg Config) (*Driver, error) { return drivers.NewClinePass(cfg) }
