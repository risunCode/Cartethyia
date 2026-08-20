package repositories

import (
	"database/sql"
	"errors"

	"github.com/cartethyia/daemon/internal/console/contracts"
)

// IsNotFound reports whether a repository operation found no durable record.
func IsNotFound(err error) bool {
	return errors.Is(err, sql.ErrNoRows) || errors.Is(err, contracts.ErrNotFound)
}
