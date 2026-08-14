# Cartethyia Engineering Documentation

Dokumen ini sengaja dibuat sedikit, tetapi setiap file membahas satu area besar secara lengkap.

## Urutan baca

1. [Architecture](architecture.md) — siapa client, siapa provider, dua API plane, package boundary, dan gambaran request.
2. [Routing](routing.md) — provider selection, account routing, quota/health, proxy/network, retry, dan fallback.
3. [Protocols](protocols.md) — OpenAI/Anthropic protocol translation, streaming, tool calling, dan upstream prompt-cache marking.
4. [Engineering](engineering.md) — coding conventions, V2 contracts, errors, redaction, observability, operations, security, dan testing.

## Istilah singkat

```text
Client   = aplikasi yang memanggil Cartethyia
Provider = upstream service yang dipanggil Cartethyia
```

Contoh client:

```text
OpenAI-compatible SDK | Anthropic-compatible SDK | CLI | IDE agent | custom HTTP app
```

Contoh provider:

```text
OpenAI API | Anthropic API | provider adapter lain yang kompatibel
```

OpenAI/Anthropic dapat menjadi nama **protocol shape** di sisi client dan nama **upstream provider** di sisi server. Jangan memakai istilah “native client” karena ambigu.

## Kontrak global

- External client ingress: `/v1/*`.
- Dashboard browser/admin: `/v2/admin/*`.
- Browser methods: `GET`, `POST`, `PATCH`, `DELETE`.
- `QUERY`: tidak didukung.
- Credential: opaque `credentialRef`, bukan plaintext secret.
- Evidence: bounded lifecycle fields, bukan prompt/raw body/provider response.
- `src.old/`: historical source, bukan active implementation.
