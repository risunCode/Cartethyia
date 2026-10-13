# Installation

Install Cartethyia on a local machine, a VPS, or with Docker, in either
**Lite** (embedded SQLite) or **Full** (external PostgreSQL) mode.

> [!WARNING]
> **Development version.** APIs, configuration, database behavior, and provider
> integrations may change without notice. Before reporting an error, update to
> the latest `dev` branch and verify the problem still occurs.

## Choose a mode

The application features are identical in both modes. The difference is only
what backs the database and how coordination is shared.

| | Lite | Full |
|---|---|---|
| Database | Embedded SQLite | External PostgreSQL |
| Coordination | In-process when Redis is unset; Redis optional | In-process when Redis is unset; Redis optional and shareable |
| Extra services | None by default; Redis optional | PostgreSQL required; Redis optional |
| Best for | Personal use, local dev, one process | VPS, sharing, selling, sustained load |
| Concurrency ceiling | **Single process** | Multiple instances |

Lite is not a reduced feature edition. Moving Lite → Full later is a JSON
backup export + import; configuration does not need to be rebuilt.

Lite is single-process and single-writer. Read the concurrency ceiling in the
table above before choosing it for a shared or sustained workload.

---

## Requirements

- **Bun** `>=1.4.0` (`package.json` `engines`)
- **Git**
- **Docker + Docker Compose** (Docker path only)
- **PostgreSQL 16+** (Full mode only)

---

## 1. Local install — Lite

Lite is the default in `.env.example`. Nothing else to install.

```bash
git clone -b dev https://github.com/risunCode/Cartethyia.git
cd Cartethyia

bun install --linker isolated
bun setup --non-interactive
bun run build
bun run start
```

Run the install from the repository root. The isolated linker installs both
workspaces and creates dependency directories for the backend and
`dashboard/`; no second dashboard install is needed.

Open `http://localhost:12800/console`.

**First boot creates the admin user and gateway API key.** This is a wizard,
not an automatic step:

1. `GET /console/api/auth/first-boot` → `{"requires_setup":true}`
2. `POST /console/api/auth/setup` with a password
3. Only then is `CARTETHYIA_API_KEY` (if set in `.env`) seeded

Skipping step 2 leaves the console unusable and the API key never inserted.

### Scripted one-shot Lite install

See [`scripts/install/lite.sh`](#7-one-shot-install-script) — one command,
`bun install` through a running service, no manual steps.

---

## 2. Local install — Full

Requires a reachable PostgreSQL server.

```bash
createdb cartethyia
```

`.env`:

```dotenv
CARTETHYIA_DB_MODE=full
DATABASE_URL=postgres://user:password@localhost:5432/cartethyia
REDIS_URL=redis://localhost:6379   # optional; omit for in-memory
```

```bash
bun install --linker isolated
bun setup --non-interactive
bun doctor
bun run build
bun run start
```

Migrations run automatically at boot and are recorded in
`cartethyia_schema_migrations`.

Redis is **never required**. Set `REDIS_URL` only for shared coordination or
multiple instances.

---

## 3. VPS install — Lite (native, no Docker)

Verified on Debian 13, 1 vCPU / 2 GB, Bun 1.4.2.

```bash
# 1. Dependencies
apt-get update && apt-get install -y git curl unzip ca-certificates openssl

# 2. Bun
curl -fsSL https://bun.sh/install | bash
export PATH="/root/.bun/bin:$PATH"

# 3. Source
mkdir -p /opt/cartethyia/data
cd /opt/cartethyia
git clone -b dev https://github.com/risunCode/Cartethyia.git repo
cd repo

# 4. Configure
cp .env.example .env
cat >> .env <<EOF
CARTETHYIA_DB_MODE=lite
NODE_ENV=production
LOG_LEVEL=warn
PORT=8080
CARTETHYIA_ENCRYPTION_KEY=$(openssl rand -hex 32)
CARTETHYIA_PUBLIC_ORIGIN=https://your.domain
CARTETHYIA_DATA_DIR=/opt/cartethyia/data
CARTETHYIA_TELEMETRY_PAYLOAD_DIR=/opt/cartethyia/data/telemetry-payloads
CARTETHYIA_INSTALL_ID_DIR=/opt/cartethyia/data/.cartethyia
EOF

# 5. Build
bun install --linker isolated
bun run build
```

### systemd

`/etc/systemd/system/cartethyia.service`:

```ini
[Unit]
Description=Cartethyia AI Gateway
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/cartethyia/repo
EnvironmentFile=/opt/cartethyia/repo/.env
Environment=PATH=/root/.bun/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/root/.bun/bin/bun run /opt/cartethyia/repo/dist/main.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=cartethyia

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now cartethyia
curl http://127.0.0.1:8080/health/ready
```

### Reverse proxy

Caddy:

```
your.domain {
    reverse_proxy 127.0.0.1:8080
}
```

Nginx must forward the client IP, otherwise per-IP rate limiting sees every
request as one IP:

```nginx
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Real-IP $remote_addr;
```

And in `.env`:

```dotenv
TRUSTED_PROXY_CIDRS=127.0.0.1/32,10.0.0.0/8
```

### Auto-deploy

`/opt/cartethyia/deploy.sh`:

```bash
#!/usr/bin/env bash
set -uo pipefail
export PATH="/root/.bun/bin:$PATH"
REPO=/opt/cartethyia/repo
LOG=/opt/cartethyia/deploy.log
LOCK=/opt/cartethyia/deploy.lock

exec 9>"$LOCK"
if ! flock -n 9; then echo "[$(date -Is)] another deploy running, skip" >> "$LOG"; exit 0; fi

cd "$REPO" || exit 1
git fetch --quiet origin dev || exit 1
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/dev)
if [ "$LOCAL" = "$REMOTE" ]; then exit 0; fi

echo "[$(date -Is)] deploy $LOCAL -> $REMOTE" >> "$LOG"
git reset --quiet --hard "$REMOTE" || exit 1
bun install --linker isolated --frozen-lockfile >> "$LOG" 2>&1 || { echo "install failed" >> "$LOG"; exit 1; }
bun run build >> "$LOG" 2>&1 || { echo "build failed" >> "$LOG"; exit 1; }

systemctl restart cartethyia
PORT=$(grep -E '^PORT=' .env | cut -d= -f2)
for i in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${PORT}/health/ready" >/dev/null 2>&1; then
    echo "[$(date -Is)] healthy" >> "$LOG"; exit 0
  fi
  sleep 3
done
echo "[$(date -Is)] UNHEALTHY, rollback to $LOCAL" >> "$LOG"
git reset --quiet --hard "$LOCAL"
systemctl restart cartethyia
exit 1
```

```bash
chmod +x /opt/cartethyia/deploy.sh
(crontab -l 2>/dev/null | grep -v 'cartethyia/deploy.sh'; echo "*/5 * * * * /opt/cartethyia/deploy.sh") | crontab -
```

**The `flock` is mandatory.** A build takes 3–5 minutes on 1 vCPU; a 1-minute
cron stacks builds until the box OOMs. The 5-minute interval plus the lock is
what keeps a small VPS alive.

### Port note

`PORT` is the one public port. `bun dev` and the production build both listen
on it; there is no separate production port. The default is 12800. A VPS whose
NAT only forwards part of the range should set `PORT` to a forwarded port —
8080 is the usual choice — and set `CARTETHYIA_PUBLIC_ORIGIN` to the same port,
or OAuth callbacks miss. `bun setup` asks on a fresh install and rewrites the
origin when it is still the default. The dashboard dev server on 5173 is local
only and does not need to be forwarded.

The app binds `0.0.0.0`, so a host-level proxy reaching the container's
internal IP works without extra configuration. Docker maps `${PORT:-12800}` to
the container's 12800, so changing `PORT` changes the host side only.

---

## 4. VPS install — Full (native)

Same as VPS Lite through step 5, then:

```dotenv
CARTETHYIA_DB_MODE=full
DATABASE_URL=postgres://user:password@host:5432/cartethyia
REDIS_URL=redis://localhost:6379
```

Install PostgreSQL:

```bash
apt-get install -y postgresql
sudo -u postgres createdb cartethyia
```

`bun doctor` validates `.env`, backend reachability, optional Redis, and
readiness. Run it after any Full-mode change.

Multiple instances are supported in Full mode. Put them behind a load balancer
and keep `REDIS_URL` shared.

---

## 5. Docker — Full (default)

**`docker-compose.yml` defaults to Full mode.** It bundles Redis but **never
PostgreSQL** — Full requires an external server reachable through
`DATABASE_URL`.

```dotenv
CARTETHYIA_DB_MODE=full
DATABASE_URL=postgres://user:password@host:5432/cartethyia
CARTETHYIA_REDIS_URL=redis://redis:6379
CARTETHYIA_ENCRYPTION_KEY=<openssl rand -hex 32>
CARTETHYIA_PUBLIC_ORIGIN=https://your.domain
```

```bash
docker compose up --build -d
docker compose logs -f app
docker compose down
```

To bundle PostgreSQL locally, add `docker-compose.override.yml`:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: cartethyia
      POSTGRES_PASSWORD: change-me
      POSTGRES_DB: cartethyia
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U cartethyia"]
      interval: 5s
      timeout: 3s
      retries: 5
    networks:
      - cartethyia

  app:
    depends_on:
      postgres:
        condition: service_healthy

volumes:
  pgdata:
```

---

## 6. Docker — Lite

Override the default:

```dotenv
CARTETHYIA_DB_MODE=lite
# DATABASE_URL is not needed in Lite.
# CARTETHYIA_REDIS_URL=   # empty or omit to use in-memory coordination in Compose
```

```bash
docker compose up --build -d
```

The app container stores Lite state and telemetry payloads in the persistent
`/app/data` volume. **Without that mount, replacing the container wipes the
database. Compose starts its bundled Redis service in Lite mode too; set
`CARTETHYIA_REDIS_URL` empty to use in-memory coordination instead. The Compose
file maps that variable to the app's `REDIS_URL`; a host `.env` `REDIS_URL`
does not override it.

> [!IMPORTANT]
> The image is built on Alpine and runs `dist/cartethyia` (the compiled
> binary). Lite state lives in the `/app/data` volume mounted above; without
> it, replacing the container wipes the database.

---

## 7. One-shot install script

[`scripts/install/lite.sh`](https://github.com/risunCode/Cartethyia/blob/dev/scripts/install/lite.sh)
— one command, Lite mode, no manual steps. Idempotent; safe to re-run.

```bash
curl -fsSL https://raw.githubusercontent.com/risunCode/Cartethyia/dev/scripts/install/lite.sh | bash
# or, from a checkout:
bash scripts/install/lite.sh
```

That script is the canonical one-shot installer; it installs system packages and
Bun, clones the repository, then hands off to the same wizard and build every
other path uses (`bun install --linker isolated` →
`bun run setup --non-interactive` → `bun run build`) and finishes with a
systemd unit. An existing `.env` is never
overwritten.

Environment overrides: `CARTETHYIA_ROOT`, `CARTETHYIA_BRANCH`,
`CARTETHYIA_PORT`, `CARTETHYIA_PUBLIC_ORIGIN`.

**NEXT after install:** the console first-boot wizard has not run yet. Open
`$ORIGIN/console`, or seed it non-interactively:

```bash
curl -s http://127.0.0.1:$PORT/console/api/auth/first-boot
curl -s -X POST http://127.0.0.1:$PORT/console/api/auth/setup \
  -H 'content-type: application/json' \
  -d '{"password":"CHANGE-ME","username":"admin"}'
```

---

## 8. Endpoints

| Endpoint | Purpose |
|---|---|
| `/health` | Process liveness |
| `/health/ready` | Database, migration, dependency readiness |
| `/metrics` | Prometheus metrics |
| `/v1/*` | Gateway API routes |
| `/console` | Dashboard |
| `/share/:token` | Public child-key enrollment |

## 9. Encryption key

`CARTETHYIA_ENCRYPTION_KEY` is a required 256-bit secret. It encrypts stored
provider credentials and API keys. `bun setup` generates it. Manual
generation, for rotation or prepared environments:

```bash
# macOS / Linux
openssl rand -hex 32

# Windows PowerShell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))

# Bun / Node
bun -e "import { randomBytes } from 'node:crypto'; console.log(randomBytes(32).toString('base64'))"
```

Either 64 hex characters or Base64 of 32 bytes is accepted. **Never change it
after credentials are stored** — stored secrets become unreadable.

## 10. Backup and migration

Numbered migrations under `migrations/` run automatically at boot and are
recorded in `cartethyia_schema_migrations`.

To move Lite → Full: export a JSON backup from Lite, restore into Full. The
configuration does not need to be rebuilt.

## See also

- [`getting-started.md`](getting-started.md) — first-run walkthrough
