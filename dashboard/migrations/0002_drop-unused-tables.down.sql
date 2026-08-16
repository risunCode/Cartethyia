-- ============================================================================
-- 0002_drop-unused-tables.down.sql — restore the schema dropped by 0002.
--
-- Recreates the 0001 tables verbatim so rolling back 0002 returns the
-- database to its pre-0002 state, as the paired .down.sql contract requires.
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'member'
                  CHECK (role IN ('member', 'admin', 'service')),
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email     ON users (email);
CREATE INDEX IF NOT EXISTS idx_users_active    ON users (is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_users_created   ON users (created_at DESC);

CREATE TABLE IF NOT EXISTS user_settings (
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key        TEXT NOT NULL,
    value      JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, key)
);

CREATE INDEX IF NOT EXISTS idx_user_settings_user ON user_settings (user_id);

CREATE TABLE IF NOT EXISTS api_keys (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    key_hash     TEXT NOT NULL UNIQUE,
    last_used_at TIMESTAMPTZ,
    expires_at   TIMESTAMPTZ,
    is_revoked   BOOLEAN NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user      ON api_keys (user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash      ON api_keys (key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_active    ON api_keys (is_revoked) WHERE is_revoked = FALSE;
CREATE INDEX IF NOT EXISTS idx_api_keys_expires   ON api_keys (expires_at);

CREATE TABLE IF NOT EXISTS quota_accounts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider        TEXT NOT NULL,
    account_label   TEXT NOT NULL,
    quota_used      BIGINT NOT NULL DEFAULT 0
                    CHECK (quota_used >= 0),
    quota_limit     BIGINT NOT NULL DEFAULT 0
                    CHECK (quota_limit >= 0),
    reset_at        TIMESTAMPTZ,
    metadata        JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, provider, account_label)
);

CREATE INDEX IF NOT EXISTS idx_quota_user            ON quota_accounts (user_id);
CREATE INDEX IF NOT EXISTS idx_quota_provider        ON quota_accounts (provider);
CREATE INDEX IF NOT EXISTS idx_quota_reset           ON quota_accounts (reset_at);
CREATE INDEX IF NOT EXISTS idx_quota_user_provider   ON quota_accounts (user_id, provider);

CREATE TABLE IF NOT EXISTS share_links (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token        TEXT NOT NULL UNIQUE,
    created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    payload      JSONB NOT NULL,
    expires_at   TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ,
    view_count   BIGINT NOT NULL DEFAULT 0
                 CHECK (view_count >= 0),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_share_token         ON share_links (token);
CREATE INDEX IF NOT EXISTS idx_share_created_by    ON share_links (created_by);
CREATE INDEX IF NOT EXISTS idx_share_expires       ON share_links (expires_at);
CREATE INDEX IF NOT EXISTS idx_share_active        ON share_links (revoked_at) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_share_created       ON share_links (created_at DESC);
