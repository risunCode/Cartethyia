# Zed Hosted API Integration — Cartethyia

> **Dokumentasi endpoint dan auth flow Zed Hosted (cloud.zed.dev)**
> Dibuat: 2026-07-30 | Status: Draft (menunggu plan aktif)

---

## Overview

Zed Hosted adalah cloud aggregator yang fronting beberapa provider LLM (Anthropic, OpenAI, Google, xAI) di belakang satu endpoint.

**Base URL:** `https://cloud.zed.dev`

---

## Auth Flow

### 1. Dapatkan Access Token

Token disimpan di **Windows Credential Manager** dengan target:
```
Target: LegacyGeneric:target=zed:url=https://zed.dev
User:   956805
```

Format credential terbaru (version 2):
```json
{"version":2,"id":"client_token_01kys4vk8dad3edy9hceybm9c5","token":"TsQrEPNEksPlzxODxIoA5bHh-3MiXHt3r1hX-vVUTXgkDVyD_aMXGV7vJh43uOyd"}
```

> **Read via Python (Windows):**
> ```python
> # Script di cred_read.py
> # Panggil CredReadW dengan target "zed:url=https://zed.dev"
> ```
> File: `C:\Users\Aria\cred_read.py`

### 2. Auth Header Format

**WAJIB:** Full JSON blob sebagai token value, bukan cuma `token` field-nya!

```http
Authorization: 956805 {"version":2,"id":"client_token_01kys4vk8dad3edy9hceybm9c5","token":"TsQrEPNE..."}
Content-Type: application/json
```

> **KENAPA:** `200 OK` vs `401` — token `TsQrEPNE...` aja return `401 Unauthorized`.
> Seluruh JSON blob sebagai password adalah format yang benar.

### 3. Get User Info

```http
GET https://cloud.zed.dev/client/users/me
Authorization: 956805 {"version":2,...}
```

**Response 200:**
```json
{
  "user": {
    "id": 956805,
    "id_v2": "user_01kxknwd4tn3nbbsavb7tsajt8",
    "username": "risunCode",
    "name": "Risun",
    "github_login": "risunCode",
    "avatar_url": "https://cloud.zed.dev/users/user_01kxknwd4tn3nbbsavb7tsajt8/avatar"
  },
  "organizations": [
    {
      "id": "org_01kxknwdw8pg460qcks6x7fn8e",
      "name": "risunCode's Organization",
      "is_personal": true
    }
  ],
  "default_organization_id": "org_01kxknwdw8pg460qcks6x7fn8e",
  "plan": {
    "plan": "zed_pro_trial",
    "plan_v2": "zed_pro_trial",
    "plan_v3": "zed_pro_trial",
    "subscription_period": {
      "started_at": "2026-07-30T09:03:06.000Z",
      "ended_at": "2026-08-13T09:03:06.000Z"
    },
    "is_usage_based_billing_enabled": false
  }
}
```

### 4. Exchange → LLM Token

```http
POST https://cloud.zed.dev/client/llm_tokens
Authorization: 956805 {"version":2,...}
Accept: application/json

{"organization_id": "org_01kxknwdw8pg460qcks6x7fn8e"}
```

**Response 200:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE3...JWT..."
}
```

Token ini **JWT** dengan TTL ±50 menit (`LLM_TOKEN_TTL_MS = 50 * 60 * 1000`).

### 5. Chat Completions — Claude Sonnet 5

```http
POST https://cloud.zed.dev/completions
Authorization: Bearer eyJhbGciOiJIUzI1NiJ9...
Content-Type: application/json

{
  "model": "claude-sonnet-5",
  "messages": [
    {"role": "system", "content": "You are Claude Sonnet 5."},
    {"role": "user", "content": "Hello!"}
  ],
  "stream": false,
  "max_tokens": 4096
}
```

**Response: 403 Trial Blocked**
```json
{
  "code": "trial_blocked",
  "message": "Trial access is blocked. If you think this is a mistake, please reach out to billing-support@zed.dev."
}
```

> ⚠️ Trial plan (`zed_pro_trial`) belum bisa akses hosted models.
> Butuh **Zed Pro $20/bulan** untuk unlock.

---

## Model List (dari Zed Docs, 2026-07-30)

| Provider | Model ID | Context |
|----------|----------|---------|
| Anthropic | `claude-sonnet-5` | ~1M |
| Anthropic | `claude-opus-4.5` | ~200k |
| OpenAI | `gpt-5.6-sol` | ~400k |
| OpenAI | `gpt-5.6-terra` | ~400k |
| OpenAI | `gpt-5.6-luna` | ~400k |
| Google | `gemini-3.5-flash` | ~200k |
| Google | `gemini-3.1-pro` | ~200k |

---

## Full Request Flow

```
┌──────────────────────────────────────────────────────┐
│                     Cartethyia                        │
│  ┌──────────┐    ┌──────────────┐    ┌───────────┐  │
│  │ Keychain  │───→│ Auth: JSON   │───→│ Exchange  │  │
│  │ Credential│    │ Blob as pw  │    │ LLM Token │  │
│  └──────────┘    └──────┬───────┘    └─────┬─────┘  │
│                          │                  │        │
│                          ▼                  ▼        │
│                     ┌──────────────────────────┐     │
│                     │ cloud.zed.dev/completions │     │
│                     │ Authorization: Bearer JWT │     │
│                     └──────────────────────────┘     │
└──────────────────────────────────────────────────────┘
```

## Notes

- **LLM Token TTL:** 50 menit, need refresh via `/client/llm_tokens`
- **Auth header** untuk user-facing endpoints (`/client/*`) = `{user_id} {full_json_blob}`
- **Auth header** untuk completions = `Bearer {llm_token}`
- **Trial = blocked** untuk completions, butuh paid plan
- Source: OmniRoute `open-sse/shared/zedAuth.ts` + `open-sse/executors/zed-hosted.ts`
- Source Zed: `crates/cloud_api_client/src/cloud_api_client.rs`
