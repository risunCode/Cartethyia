package accounts

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"sync"
)

// FileStore is an explicit durable adapter for deployments that do not yet
// provide the PostgreSQL account repository. Metadata is JSON; secret material
// is AES-GCM encrypted with the caller-provided key and is never serialized in
// plaintext. Runtime composition must inject it deliberately.
type FileStore struct {
	mu    sync.Mutex
	path  string
	key   [32]byte
	state fileStoreState
}

type fileStoreState struct {
	Accounts map[string]*AccountConfig    `json:"accounts"`
	Records  map[string]*OAuthTokenRecord `json:"records"`
	Secrets  map[string]fileSecret        `json:"secrets"`
}
type fileSecret struct {
	Access  string `json:"access,omitempty"`
	Refresh string `json:"refresh,omitempty"`
}

func OpenFileStore(path string, key []byte) (*FileStore, error) {
	if path == "" {
		return nil, errors.New("auth file store: path is required")
	}
	if len(key) < 16 {
		return nil, errors.New("auth file store: encryption key must be at least 16 bytes")
	}
	f := &FileStore{path: path}
	f.key = sha256.Sum256(key)
	f.state = fileStoreState{Accounts: map[string]*AccountConfig{}, Records: map[string]*OAuthTokenRecord{}, Secrets: map[string]fileSecret{}}
	if err := f.load(); err != nil {
		return nil, err
	}
	return f, nil
}

func (f *FileStore) Close() error { return nil }
func (f *FileStore) Put(ctx context.Context, cfg *AccountConfig) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := cfg.Validate(); err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.state.Accounts[cfg.ID] = cloneFileConfig(cfg)
	return f.saveLocked()
}
func (f *FileStore) Get(ctx context.Context, id string) (*AccountConfig, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	v, ok := f.state.Accounts[id]
	if !ok {
		return nil, ErrAccountNotFound
	}
	return cloneFileConfig(v), nil
}
func (f *FileStore) List(ctx context.Context) ([]*AccountConfig, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	ids := make([]string, 0, len(f.state.Accounts))
	for id := range f.state.Accounts {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	out := make([]*AccountConfig, 0, len(ids))
	for _, id := range ids {
		out = append(out, cloneFileConfig(f.state.Accounts[id]))
	}
	return out, nil
}
func (f *FileStore) Delete(ctx context.Context, id string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.state.Accounts, id)
	delete(f.state.Records, id)
	delete(f.state.Secrets, id)
	return f.saveLocked()
}

func (f *FileStore) PutAccess(ctx context.Context, id string, s *Secret) error {
	return f.putSecret(ctx, id, s, true)
}
func (f *FileStore) PutRefresh(ctx context.Context, id string, s *Secret) error {
	return f.putSecret(ctx, id, s, false)
}
func (f *FileStore) GetAccess(ctx context.Context, id string) (*Secret, error) {
	return f.getSecret(ctx, id, true)
}
func (f *FileStore) GetRefresh(ctx context.Context, id string) (*Secret, error) {
	return f.getSecret(ctx, id, false)
}
func (f *FileStore) putSecret(ctx context.Context, id string, s *Secret, access bool) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if id == "" {
		return NewError(ErrKindInvalidRequest, "", id, errors.New("account id is required"))
	}
	var material []byte
	if s != nil {
		material = s.Reveal()
	}
	if s != nil {
		s.Close()
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	slot := f.state.Secrets[id]
	if len(material) == 0 {
		if access {
			slot.Access = ""
		} else {
			slot.Refresh = ""
		}
	} else {
		enc, err := f.encrypt(material)
		for i := range material {
			material[i] = 0
		}
		if err != nil {
			return err
		}
		if access {
			slot.Access = enc
		} else {
			slot.Refresh = enc
		}
	}
	f.state.Secrets[id] = slot
	return f.saveLocked()
}
func (f *FileStore) getSecret(ctx context.Context, id string, access bool) (*Secret, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	slot, ok := f.state.Secrets[id]
	if !ok {
		return nil, ErrSecretNotFound
	}
	encoded := slot.Refresh
	if access {
		encoded = slot.Access
	}
	if encoded == "" {
		return nil, ErrSecretNotFound
	}
	material, err := f.decrypt(encoded)
	if err != nil {
		return nil, NewError(ErrKindStorage, "", id, err)
	}
	return NewSecret(material), nil
}

func (f *FileStore) PutRecord(ctx context.Context, r *OAuthTokenRecord) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if r == nil {
		return NewError(ErrKindInvalidRequest, "", "", errors.New("record is required"))
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.state.Records[r.AccountID] = cloneFileRecord(r)
	return f.saveLocked()
}
func (f *FileStore) GetRecord(ctx context.Context, id string) (*OAuthTokenRecord, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	r, ok := f.state.Records[id]
	if !ok {
		return nil, ErrRecordNotFound
	}
	return cloneFileRecord(r), nil
}
func (f *FileStore) DeleteRecord(ctx context.Context, id string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.state.Records, id)
	return f.saveLocked()
}
func (f *FileStore) ListRecords(ctx context.Context) ([]*OAuthTokenRecord, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	ids := make([]string, 0, len(f.state.Records))
	for id := range f.state.Records {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	out := make([]*OAuthTokenRecord, 0, len(ids))
	for _, id := range ids {
		out = append(out, cloneFileRecord(f.state.Records[id]))
	}
	return out, nil
}
func (f *FileStore) CompareAndSwap(ctx context.Context, expected int64, r *OAuthTokenRecord) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if r == nil || r.AccountID == "" {
		return NewError(ErrKindInvalidRequest, "", "", errors.New("record is required"))
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	current, ok := f.state.Records[r.AccountID]
	if expected < 0 {
		if ok {
			return ErrVersionMismatch
		}
	} else if !ok || current.Version != expected {
		return ErrVersionMismatch
	}
	next := cloneFileRecord(r)
	next.Version = expected + 1
	f.state.Records[r.AccountID] = next
	return f.saveLocked()
}

// The file store also satisfies the three durable interfaces through explicit
// method names, avoiding ambiguous Get/Put methods in one concrete type.
type FileAccountStore struct{ *FileStore }

func (f *FileStore) Accounts() AccountConfigStore { return FileAccountStore{f} }

type FileRecordStore struct{ *FileStore }

func (f *FileStore) Records() RecordStore { return FileRecordStore{f} }

type FileSecretStore struct{ *FileStore }

func (f *FileStore) Secrets() SecretStore { return FileSecretStore{f} }
func (f FileAccountStore) Put(c context.Context, v *AccountConfig) error {
	return f.FileStore.Put(c, v)
}
func (f FileAccountStore) Get(c context.Context, id string) (*AccountConfig, error) {
	return f.FileStore.Get(c, id)
}
func (f FileAccountStore) List(c context.Context) ([]*AccountConfig, error) {
	return f.FileStore.List(c)
}
func (f FileAccountStore) Delete(c context.Context, id string) error {
	return f.FileStore.Delete(c, id)
}
func (f FileRecordStore) Put(c context.Context, v *OAuthTokenRecord) error {
	return f.FileStore.PutRecord(c, v)
}
func (f FileRecordStore) Get(c context.Context, id string) (*OAuthTokenRecord, error) {
	return f.FileStore.GetRecord(c, id)
}
func (f FileRecordStore) Delete(c context.Context, id string) error {
	return f.FileStore.DeleteRecord(c, id)
}
func (f FileRecordStore) List(c context.Context) ([]*OAuthTokenRecord, error) {
	return f.FileStore.ListRecords(c)
}
func (f FileRecordStore) CompareAndSwap(c context.Context, e int64, v *OAuthTokenRecord) error {
	return f.FileStore.CompareAndSwap(c, e, v)
}
func (f FileSecretStore) PutAccess(c context.Context, id string, s *Secret) error {
	return f.FileStore.PutAccess(c, id, s)
}
func (f FileSecretStore) PutRefresh(c context.Context, id string, s *Secret) error {
	return f.FileStore.PutRefresh(c, id, s)
}
func (f FileSecretStore) GetAccess(c context.Context, id string) (*Secret, error) {
	return f.FileStore.GetAccess(c, id)
}
func (f FileSecretStore) GetRefresh(c context.Context, id string) (*Secret, error) {
	return f.FileStore.GetRefresh(c, id)
}
func (f FileSecretStore) Delete(c context.Context, id string) error { return f.FileStore.Delete(c, id) }

func (f *FileStore) load() error {
	raw, err := os.ReadFile(f.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if len(raw) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, &f.state); err != nil {
		return errors.New("auth file store: malformed state")
	}
	if f.state.Accounts == nil {
		f.state.Accounts = map[string]*AccountConfig{}
	}
	if f.state.Records == nil {
		f.state.Records = map[string]*OAuthTokenRecord{}
	}
	if f.state.Secrets == nil {
		f.state.Secrets = map[string]fileSecret{}
	}
	return nil
}
func (f *FileStore) saveLocked() error {
	raw, err := json.Marshal(f.state)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(f.path), 0700); err != nil {
		return err
	}
	tmp := f.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, f.path)
}
func (f *FileStore) encrypt(raw []byte) (string, error) {
	block, err := aes.NewCipher(f.key[:])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	out := gcm.Seal(nonce, nonce, raw, nil)
	return base64.RawStdEncoding.EncodeToString(out), nil
}
func (f *FileStore) decrypt(encoded string) ([]byte, error) {
	raw, err := base64.RawStdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(f.key[:])
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	n := gcm.NonceSize()
	if len(raw) < n {
		return nil, errors.New("auth file store: invalid secret")
	}
	return gcm.Open(nil, raw[:n], raw[n:], nil)
}
func cloneFileConfig(v *AccountConfig) *AccountConfig {
	if v == nil {
		return nil
	}
	out := *v
	out.Labels = map[string]string{}
	for k, x := range v.Labels {
		out.Labels[k] = x
	}
	out.Scopes = append([]string(nil), v.Scopes...)
	return &out
}
func cloneFileRecord(v *OAuthTokenRecord) *OAuthTokenRecord {
	if v == nil {
		return nil
	}
	out := *v
	return &out
}

var _ AccountConfigStore = FileAccountStore{}
var _ SecretStore = FileSecretStore{}
var _ RecordStore = FileRecordStore{}
