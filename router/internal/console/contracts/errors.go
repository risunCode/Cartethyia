package contracts

import "errors"

// ErrNotFound marks a repository lookup or mutation that targeted no record.
// Storage implementations may wrap their native sentinel while preserving
// errors.Is for lower-level callers.
var ErrNotFound = errors.New("console contract: not found")
