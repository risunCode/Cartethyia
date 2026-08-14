// Package backup orchestrates scheduled PostgreSQL dumps, optional streaming
// encryption, off-site upload to a Telegram Bot chat, retention of older
// archives, and structured failure reporting.
//
// The package defines interfaces for every side effect; concrete callers
// inject them so this code never shells out, dials the network, reads a key
// from disk, or embeds a production endpoint. Lifecycle is governed by
// context.Context: a cancelled context aborts the dump, the upload, the
// retention sweep, and the failure report in flight.
package backup
