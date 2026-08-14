// Package store owns the durable account-storage boundary. Implementations
// remain in the parent package until a database adapter is selected.
package store

import "github.com/cartethyia/daemon/internal/accounts"

type SecretStore = accounts.SecretStore
type RecordStore = accounts.RecordStore
type AccountConfigStore = accounts.AccountConfigStore
type RefreshLeaseStore = accounts.RefreshLeaseStore
type RefreshLeaseHandle = accounts.RefreshLeaseHandle
type AccountConfig = accounts.AccountConfig
type OAuthTokenRecord = accounts.OAuthTokenRecord

type Secret = accounts.Secret

var ErrSecretNotFound = accounts.ErrSecretNotFound
var ErrRecordNotFound = accounts.ErrRecordNotFound
var ErrAccountNotFound = accounts.ErrAccountNotFound
var ErrVersionMismatch = accounts.ErrVersionMismatch
