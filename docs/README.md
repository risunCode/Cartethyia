# Cartethyia Engineering Documentation

Dokumentasi dibagi per domain besar. Setiap file menggabungkan beberapa bagian
yang saling terkait supaya tidak muncul satu Markdown untuk setiap detail kecil.
Dokumen membahas active Go daemon; `src.old/` hanya arsip historis.

## Urutan baca

1. [Architecture](architecture.md) — dua API plane, request lifecycle, route
   surface, package ownership, dependency composition, storage boundary, dan
   invariants.
2. [Routing](routing.md) — provider/account/network selection, account state,
   retry/fallback, resolution cache, provider cache-plan boundary, dan safe
   routing evidence.
3. [Protocols](protocols.md) — normalized contracts, OpenAI/Anthropic surfaces,
   translation, reasoning, tools, streaming, provider capabilities, upstream
   prompt caching, dan batas RTK token saver.
4. [Operations](operations.md) — environment, Laragon, PostgreSQL authority,
   Redis fallback, Docker/Compose, health, shutdown, diagnosis, backup, dan
   deployment verification.
5. [Engineering](engineering.md) — coding conventions, closed contracts, error
   taxonomy, secret/redaction boundary, observability, security, and testing.

## Istilah singkat

```text
Client   = aplikasi yang memanggil Cartethyia
Provider = upstream service yang dipanggil Cartethyia
Surface  = bentuk kontrak client, bukan tujuan provider
Account  = credential slot provider yang dipilih untuk satu attempt
```

Contoh client:

```text
OpenAI-compatible SDK | Anthropic-compatible SDK | CLI | IDE agent | HTTP app
```

Contoh provider:

```text
OpenAI | Anthropic | Codex | Antigravity | Grok Build | adapter terdaftar lain
```

OpenAI/Anthropic dapat menjadi nama **protocol shape** di sisi client dan nama
**upstream provider** di sisi server. Jangan memakai istilah “native client”
karena ambigu.

## Kontrak global

- External client ingress: `/v1/*`.
- Dashboard browser/admin: `/console/*`.
- Health/metrics: `GET /health`, `GET /metrics`.
- Browser methods: `GET`, `POST`, `PATCH`, `DELETE`.
- `QUERY`: tidak didukung.
- Credential: opaque `credentialRef`, bukan plaintext secret.
- PostgreSQL: durable authority untuk account/secret/lease/persistence.
- Redis: optional cache/coordination backend dengan memory fallback.
- Evidence: bounded lifecycle fields, bukan prompt/raw body/provider response.
- RTK: package lokal yang tersedia, belum otomatis dipasang di active dispatch.
- Headroom external service: sudah dihapus dari active Go runtime.
- `src.old/`: historical source, bukan active implementation.

## Versi dan status

Perubahan rewrite core dicatat di [CHANGELOG](../CHANGELOG.md) pada versi
`2.1.0`. Release tersebut adalah checkpoint awal Go rewrite sebelum hardening,
provider live E2E yang lebih luas, dan race-enabled verification lintas platform.
