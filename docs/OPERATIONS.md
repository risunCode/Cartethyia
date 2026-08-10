# Operations

## Docker

```bash
docker build -t cartethyia .
: "${CONSOLE_PASSWORD:?Set a non-empty CONSOLE_PASSWORD first}"
: "${CONSOLE_JWT_SECRET:?Set a random CONSOLE_JWT_SECRET first}"
docker run --rm -p 12800:8080 \
  -e PORT=8080 -e DATA_DIR=/app/data \
  -e CONSOLE_PASSWORD="$CONSOLE_PASSWORD" \
  -e CONSOLE_JWT_SECRET="$CONSOLE_JWT_SECRET" \
  -e BOOTSTRAP_PROXY_API_KEY="${BOOTSTRAP_PROXY_API_KEY:-}" \
  -v cartethyia-data:/app/data cartethyia
```

The multi-stage image builds the server and dashboard, then copies runtime assets into the final image. Persist `/app/data` and inject secrets instead of baking them into layers.

## Railway

Use Railway's `PORT`, persist `DATA_DIR` when possible, inject secrets through variables, and set the health path to `/health`. Railway needs a successful status code; the body is informational. Verify reverse-proxy stream timeouts.

## Health checks

`GET /health` is unauthenticated and cheap. It does not call providers, refresh quotas, scan accounts, or require a console session. Use account health, quota, logs, and an authenticated request to check readiness.

- Liveness fails: process, port, or deployment issue.
- Liveness passes with `401`: client credential issue.
- Liveness passes with `429`: admission, account, quota, or provider capacity issue.
- Liveness passes with `5xx`: provider, transport, translation, or internal issue.

## Security

Store API keys, OAuth tokens, console passwords, JWT secrets, proxy credentials, and custom headers in a secret manager. SSRF and redirect validation protect upstream/proxy URLs. Request body, stream, timeout, concurrency, per-IP, login-rate, and API-key limits are security controls, not optional performance tuning.

Logs and public errors redact credentials and bound sensitive content. Rotate compromised credentials immediately.

## Backup and restore

Back up `DATA_DIR` and the configuration database according to the recovery objective. Runtime telemetry may have a separate database and retention policy. Restore validates version, table allowlists, and column allowlists, then applies changes transactionally. Encrypt backups and restrict access.

## Troubleshooting

- Startup failure: check Bun, writable `DATA_DIR`, port, and required secrets.
- Green health but failed API: check API key, ACL, accounts, capabilities, quota, and logs.
- Repeated `429`: inspect account cooldowns, API-key limits, provider quota, and proxy capacity.
- Early stream termination: check upstream/proxy timeout, buffering, terminal events, and stream limits.
- OAuth loop: `reauth_required` means a new OAuth login is needed; it is not a transient retry.

## Performance

Measure offered load and completed responses separately. Record request count, concurrency, achieved RPM, p50/p95/p99, error classes, RSS delta, and connection reuse. Test 8k, 12k, 15k, and 20k RPM opt-in levels with a deterministic local fixture before claiming deployment capacity.
