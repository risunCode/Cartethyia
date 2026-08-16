package accounts

import (
    "context"
    "errors"
    "fmt"
    "testing"
    "time"
)

func TestCredentialAndSecretEdgeCases(t *testing.T) {
    for _, tc := range []struct{ kind CredentialKind; want CredentialOrigin }{
        {KindAPIKey, OriginAPIKey}, {KindOAuth, OriginOAuth}, {KindDevice, OriginOAuthDevice},
        {KindAccessOnly, OriginExternal}, {KindCustom, OriginExternal},
    } { if got := DefaultOrigin(tc.kind); got != tc.want { t.Fatalf("origin(%q)=%q", tc.kind, got) } }
    now := time.Unix(100, 0)
    if (&TokenSet{}).NeedsRefresh(now, 0) || (*TokenSet)(nil).NeedsRefresh(now, 0) { t.Fatal("empty token needs refresh") }
    ts := &TokenSet{Access: NewSecretFromString("a"), ExpiresAt: now.Add(time.Minute)}
    if ts.NeedsRefresh(now, 0) || !ts.NeedsRefresh(now, time.Minute) { t.Fatal("expiry skew not honored") }
    if NewSecretFromString("x").Equal(NewSecretFromString("y")) || !NewSecretFromString("x").Equal(NewSecretFromString("x")) { t.Fatal("secret equality") }
    if !ConstantTimeEqual([]byte("x"), []byte("x")) || ConstantTimeEqual([]byte("x"), []byte("xy")) { t.Fatal("raw equality") }
    if NewSecretFromString("abc").Len() != 3 || (*Secret)(nil).Len() != 0 || NewSecretFromString("abc").RevealString() != "abc" { t.Fatal("secret accessors") }
    if NewSecretFromString("x").String() != "<redacted-secret>" || NewSecretFromString("x").GoString() != "<redacted-secret>" { t.Fatal("redaction") }
    ts.Close()
}

func TestErrorsProviderCodeAndReauth(t *testing.T) {
    cause := errors.New("unsafe")
    e := NewProviderError(ErrKindReauthentication, "p", "a", " bad code! "+fmt.Sprintf("%s", ""), cause)
    if e.Code != "" || !RequiresReauth(e) || Classify(e) != ErrKindReauthentication { t.Fatalf("provider error=%#v", e) }
    e = NewProviderError(ErrKindRefreshFatal, "p", "a", " ok_code-1 ", context.Canceled)
    if e.Code != "OK_CODE-1" || !errors.Is(e, context.Canceled) || RequiresReauth(e) { t.Fatalf("normalized error=%#v", e) }
    if Classify(nil) != "" || Classify(errors.New("x")) != ErrKindUnknown || !RequiresReauth(NewError(ErrKindInvalidRequest, "", "", nil)) { t.Fatal("classification") }
}

func TestMemoryStoresListDeleteAndCache(t *testing.T) {
    ctx := context.Background()
    ss := NewMemorySecretStore()
    if err := ss.PutAccess(ctx, "a", NewSecretFromString("access")); err != nil { t.Fatal(err) }
    if err := ss.PutRefresh(ctx, "a", NewSecretFromString("refresh")); err != nil { t.Fatal(err) }
    if err := ss.Delete(ctx, "a"); err != nil { t.Fatal(err) }
    if _, err := ss.GetAccess(ctx, "a"); !errors.Is(err, ErrSecretNotFound) { t.Fatal(err) }
    rs := NewMemoryRecordStore()
    r := &OAuthTokenRecord{AccountID:"a", ProviderID:"p"}
    if err := rs.Put(ctx, r); err != nil { t.Fatal(err) }
    if err := rs.CompareAndSwap(ctx, -1, r); !errors.Is(err, ErrVersionMismatch) { t.Fatal("duplicate CAS") }
    if err := rs.CompareAndSwap(ctx, 0, r); err != nil { t.Fatal(err) }
    if got, _ := rs.List(ctx); len(got) != 1 || got[0].Version != 1 { t.Fatalf("records=%#v", got) }
    as := NewMemoryAccountConfigStore()
    if err := as.Put(ctx, &AccountConfig{ID:"b", ProviderID:"p", Kind:KindAPIKey}); err != nil { t.Fatal(err) }
    if err := as.Put(ctx, &AccountConfig{ID:"a", ProviderID:"p", Kind:KindOAuth}); err != nil { t.Fatal(err) }
    list, err := as.List(ctx); if err != nil || len(list) != 2 || list[0].ID != "a" { t.Fatalf("list=%#v err=%v", list, err) }
    cache := NewCachedAccountConfigStore(as, AccountConfigCacheOptions{TTL:time.Hour, MaxEntries:1})
    if _, err := cache.Get(ctx, "a"); err != nil { t.Fatal(err) }
    if _, err := cache.Get(ctx, "a"); err != nil { t.Fatal(err) }
    if err := cache.Delete(ctx, "a"); err != nil { t.Fatal(err) }
    if _, err := cache.Get(ctx, "a"); !errors.Is(err, ErrAccountNotFound) { t.Fatal(err) }
}

func TestMemoryRefreshLeaseEdgeCases(t *testing.T) {
    ctx := context.Background(); ls := NewMemoryRefreshLeaseStore()
    if _, ok, err := ls.Acquire(ctx, "", "o", time.Second); ok || err == nil { t.Fatal("invalid acquire") }
    h, ok, err := ls.Acquire(ctx, "a", "o", time.Second); if err != nil || !ok { t.Fatal(err) }
    if _, ok, _ := ls.Acquire(ctx, "a", "o2", time.Second); ok { t.Fatal("lease not exclusive") }
    if err := h.Renew(ctx, time.Second); err != nil { t.Fatal(err) }
    if err := h.Release(ctx); err != nil { t.Fatal(err) }; if err := h.Release(ctx); err != nil { t.Fatal(err) }
}

func TestFileStoreRecordsAndAdapters(t *testing.T) {
    ctx := context.Background(); path := t.TempDir()+"/accounts.json"
    fs, err := OpenFileStore(path, []byte("0123456789012345")); if err != nil { t.Fatal(err) }
    if _, err := fs.GetRecord(ctx, "missing"); !errors.Is(err, ErrRecordNotFound) { t.Fatal(err) }
    if err := fs.PutRecord(ctx, nil); err == nil { t.Fatal("nil record accepted") }
    r := &OAuthTokenRecord{AccountID:"a", ProviderID:"p", Kind:KindOAuth}
    if err := fs.PutRecord(ctx, r); err != nil { t.Fatal(err) }
    if rows, err := fs.ListRecords(ctx); err != nil || len(rows) != 1 { t.Fatalf("rows=%#v err=%v", rows, err) }
    if err := fs.DeleteRecord(ctx, "a"); err != nil { t.Fatal(err) }
    canceled, cancel := context.WithCancel(ctx); cancel()
    if _, err := fs.Get(canceled, "a"); !errors.Is(err, context.Canceled) { t.Fatal(err) }
    if err := fs.Accounts().Put(ctx, &AccountConfig{ID:"a", ProviderID:"p", Kind:KindAPIKey}); err != nil { t.Fatal(err) }
    if _, err := fs.Accounts().Get(ctx, "a"); err != nil { t.Fatal(err) }
    if err := fs.Accounts().Delete(ctx, "a"); err != nil { t.Fatal(err) }
}
