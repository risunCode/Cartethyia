package cache

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"strings"
	"time"
)

// SharedContentSpec identifies an encrypted, tenant-scoped content value. The
// Identity is an opaque caller-computed identity (normally a digest of the
// final target-wire request); it is never included in errors or observability.
type SharedContentSpec struct {
	TenantID   string
	Namespace  string
	Identity   string
	Provider   string
	Model      string
	Surface    string
	Generation Generation
}

const (
	sharedContentVersion    byte = 1
	sharedContentNonceSize       = 12
	sharedContentTagSize         = 16
	sharedContentHeaderSize      = 1 + 1 + 4 + 8*4 + sharedContentNonceSize
	maxSharedIdentityBytes       = 512
	maxSharedNamespaceBytes      = 128
	maxSharedTenantBytes         = 256
)

var (
	ErrContentIneligible    = errors.New("cache: shared content ineligible")
	ErrContentTooLarge      = errors.New("cache: shared content exceeds byte limit")
	ErrContentMalformed     = errors.New("cache: shared content malformed")
	ErrContentUndecryptable = errors.New("cache: shared content unavailable")
)

// SharedContentStore provides one bounded encrypted envelope for transformed
// content and complete response bodies. Redis/L1 remains advisory because all
// unusable remote values are treated as misses and can be recomputed.
type SharedContentStore struct {
	backend  Cache
	master   []byte
	maxBytes int
	ttl      time.Duration
}

// NewSharedContentStore constructs a tenant-scoped AEAD store. A non-empty
// process/account encryption key is required; request material is never used
// as key material. TTL is capped at one hour.
func NewSharedContentStore(backend Cache, masterKey []byte, maxBytes int, ttl time.Duration) (*SharedContentStore, error) {
	if backend == nil || len(masterKey) == 0 {
		return nil, ErrContentIneligible
	}
	if maxBytes <= 0 {
		maxBytes = 1 << 20
	}
	if ttl <= 0 || ttl > MaxSharedContentTTL {
		ttl = MaxSharedContentTTL
	}
	return &SharedContentStore{backend: backend, master: append([]byte(nil), masterKey...), maxBytes: maxBytes, ttl: ttl}, nil
}

func (s *SharedContentStore) key(spec SharedContentSpec) (Key, error) {
	if s == nil || s.backend == nil || len(s.master) == 0 || strings.TrimSpace(spec.TenantID) == "" || strings.TrimSpace(spec.Namespace) == "" || strings.TrimSpace(spec.Identity) == "" || len(spec.TenantID) > maxSharedTenantBytes || len(spec.Namespace) > maxSharedNamespaceBytes || len(spec.Identity) > maxSharedIdentityBytes || len(spec.Provider) > maxSharedNamespaceBytes || len(spec.Model) > maxSharedNamespaceBytes || len(spec.Surface) > maxSharedNamespaceBytes || strings.ContainsRune(spec.TenantID, '\x00') || strings.ContainsRune(spec.Namespace, '\x00') || strings.ContainsRune(spec.Identity, '\x00') || strings.TrimSpace(spec.Provider) == "" || strings.TrimSpace(spec.Model) == "" || strings.TrimSpace(spec.Surface) == "" || spec.Generation.IsZero() {
		return Key{}, ErrContentIneligible
	}
	tenantNS := opaqueTenantNamespace(spec.TenantID, spec.Namespace)
	identitySum := sha256.Sum256([]byte(spec.Identity))
	return NewKey(spec.Model, spec.Surface, []CapabilityRequirement{
		"content", CapabilityRequirement(tenantNS), CapabilityRequirement(hex.EncodeToString(identitySum[:])),
	}, spec.Generation, Scope{Provider: spec.Provider}, NetworkPolicy{}, AffinityNone)
}

func opaqueTenantNamespace(tenant, namespace string) string {
	sum := sha256.Sum256([]byte("cartethyia-content-v1\x00" + tenant + "\x00" + namespace))
	return hex.EncodeToString(sum[:])
}

func deriveContentKey(master []byte, tenant, namespace string) []byte {
	mac := hmac.New(sha256.New, master)
	mac.Write([]byte("cartethyia-content-aead-v1\x00"))
	mac.Write([]byte(tenant))
	mac.Write([]byte{0})
	mac.Write([]byte(namespace))
	return mac.Sum(nil)
}

func generationBytes(g Generation) [32]byte {
	var out [32]byte
	binary.BigEndian.PutUint64(out[0:8], g.Catalog)
	binary.BigEndian.PutUint64(out[8:16], g.Credentials)
	binary.BigEndian.PutUint64(out[16:24], g.Health)
	binary.BigEndian.PutUint64(out[24:32], g.Network)
	return out
}

func sealSharedContent(master []byte, spec SharedContentSpec, value []byte) ([]byte, error) {
	key := deriveContentKey(master, spec.TenantID, spec.Namespace)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, ErrContentUndecryptable
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, ErrContentUndecryptable
	}
	var nonce [sharedContentNonceSize]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return nil, ErrContentUndecryptable
	}
	gen := generationBytes(spec.Generation)
	// Header has no tenant plaintext. Generation and plaintext length are
	// authenticated as AAD and validated again after opening.
	header := make([]byte, sharedContentHeaderSize)
	header[0] = sharedContentVersion
	header[1] = byte(len(spec.Surface)) // bounded metadata only; no content
	binary.BigEndian.PutUint32(header[2:6], uint32(len(value)))
	copy(header[6:38], gen[:])
	copy(header[38:50], nonce[:])
	sealed := aead.Seal(nil, nonce[:], value, header)
	return append(header, sealed...), nil
}

func openSharedContent(master []byte, spec SharedContentSpec, payload []byte, maxBytes int) ([]byte, error) {
	if len(payload) < sharedContentHeaderSize+sharedContentTagSize {
		return nil, ErrContentMalformed
	}
	header := payload[:sharedContentHeaderSize]
	if header[0] != sharedContentVersion || int(binary.BigEndian.Uint32(header[2:6])) > maxBytes {
		return nil, ErrContentMalformed
	}
	gen := generationBytes(spec.Generation)
	if !hmac.Equal(header[6:38], gen[:]) {
		return nil, ErrGenerationMismatch
	}
	key := deriveContentKey(master, spec.TenantID, spec.Namespace)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, ErrContentUndecryptable
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, ErrContentUndecryptable
	}
	opened, err := aead.Open(nil, header[38:50], payload[sharedContentHeaderSize:], header)
	if err != nil {
		return nil, ErrContentUndecryptable
	}
	if len(opened) != int(binary.BigEndian.Uint32(header[2:6])) || len(opened) > maxBytes {
		return nil, ErrContentMalformed
	}
	return opened, nil
}

// Get returns a defensive copy. Malformed, stale, undecryptable, or advisory
// backend failures become a typed miss so request execution can recompute.
func (s *SharedContentStore) Get(ctx context.Context, spec SharedContentSpec) (Entry, error) {
	if ctx == nil {
		return Entry{}, ErrInvalidContext
	}
	key, err := s.key(spec)
	if err != nil {
		return Entry{}, err
	}
	entry, err := s.backend.Get(ctx, key)
	if err != nil {
		if ctx != nil && ctx.Err() != nil {
			return Entry{}, ctx.Err()
		}
		if errors.Is(err, ErrGenerationMismatch) {
			return Entry{}, err
		}
		return Entry{}, &MissError{Key: key, Reason: "unavailable"}
	}
	opened, err := openSharedContent(s.master, spec, entry.Value, s.maxBytes)
	if err != nil {
		if errors.Is(err, ErrGenerationMismatch) {
			return Entry{}, err
		}
		return Entry{}, &MissError{Key: key, Reason: "invalid"}
	}
	entry.Value = opened
	entry.Hit = true
	entry.HitReason = HitReasonSharedContent
	return entry, nil
}

// Set encrypts before handing bytes to the bounded backend. It never stores
// plaintext in L0/Redis and caps the effective TTL at one hour.
func (s *SharedContentStore) Set(ctx context.Context, spec SharedContentSpec, value []byte) error {
	if ctx == nil {
		return ErrInvalidContext
	}
	key, err := s.key(spec)
	if err != nil {
		return err
	}
	if len(value) == 0 {
		return ErrContentIneligible
	}
	if len(value) > s.maxBytes || uint64(len(value)) > uint64(^uint32(0)) {
		return ErrContentTooLarge
	}
	sealed, err := sealSharedContent(s.master, spec, value)
	if err != nil {
		return err
	}
	if len(sealed) > s.maxBytes+sharedContentHeaderSize+sharedContentNonceSize+sharedContentTagSize {
		return ErrContentTooLarge
	}
	if err := s.backend.Set(ctx, key, sealed, s.ttl); err != nil {
		if ctx != nil && ctx.Err() != nil {
			return ctx.Err()
		}
		return nil // advisory shared storage must never fail the request
	}
	return nil
}

func (s *SharedContentStore) Delete(ctx context.Context, spec SharedContentSpec) error {
	if ctx == nil {
		return ErrInvalidContext
	}
	key, err := s.key(spec)
	if err != nil {
		return err
	}
	if err := s.backend.Delete(ctx, key); err != nil && ctx != nil && ctx.Err() != nil {
		return ctx.Err()
	}
	return nil
}

func (s *SharedContentStore) Close() error {
	if s == nil || s.backend == nil {
		return nil
	}
	return s.backend.Close()
}
