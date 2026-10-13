#!/usr/bin/env bash
# Install Cartethyia (Lite) in one shot.
#
#   bash scripts/install/lite.sh
#   curl -fsSL <raw-url> | bash
#
# Idempotent: safe to re-run. An existing .env is never overwritten.
#
# Environment overrides:
#   CARTETHYIA_ROOT            install root          (default /opt/cartethyia)
#   CARTETHYIA_BRANCH          git branch            (default dev)
#   CARTETHYIA_PORT            HTTP port             (default 8080)
#   CARTETHYIA_PUBLIC_ORIGIN   external URL          (default http://localhost:8080)
#
# Lite mode is single-process and single-writer: this script stops any running
# service before touching the database and never opens the data dir itself.
set -euo pipefail

ROOT=${CARTETHYIA_ROOT:-/opt/cartethyia}
BRANCH=${CARTETHYIA_BRANCH:-dev}
PORT=${CARTETHYIA_PORT:-8080}
ORIGIN=${CARTETHYIA_PUBLIC_ORIGIN:-http://localhost:8080}
REPO="$ROOT/repo"

say() { printf '\033[1;36m==>\033[0m %s\n' "$1"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$1" >&2; exit 1; }

# --- 1. system packages ----------------------------------------------------
if command -v apt-get >/dev/null 2>&1; then
  say "installing system packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq && apt-get install -y -qq \
    git curl unzip ca-certificates openssl \
    || die "apt-get install failed"
fi

# --- 2. bun ----------------------------------------------------------------
if ! command -v bun >/dev/null 2>&1; then
  say "installing bun"
  curl -fsSL https://bun.sh/install | bash || die "bun install failed"
fi
BUN=$(command -v bun || echo "$HOME/.bun/bin/bun")
[ -x "$BUN" ] || die "bun not found after install"
export PATH="$(dirname "$BUN"):$PATH"
say "bun $($BUN --version)"
case "$($BUN --version)" in
  0.*|1.[0-3].*) die "Bun 1.4.0 or newer is required (this is $($BUN --version))" ;;
esac

# --- 3. source -------------------------------------------------------------
mkdir -p "$ROOT/data"
if [ ! -d "$REPO/.git" ]; then
  say "cloning $BRANCH into $REPO"
  git clone -b "$BRANCH" https://github.com/risunCode/Cartethyia.git "$REPO" \
    || die "git clone failed"
else
  say "updating existing checkout"
  git -C "$REPO" fetch --quiet origin "$BRANCH"
  git -C "$REPO" reset --quiet --hard "origin/$BRANCH"
fi

# --- 4. .env ---------------------------------------------------------------
cd "$REPO"
if [ ! -f .env ]; then
  say "creating .env"
  cp .env.example .env
  KEY=$(openssl rand -hex 32)
  set_kv() {
    if grep -q "^$1=" .env; then
      sed -i "s|^$1=.*|$1=$2|" .env
    else
      printf '%s=%s\n' "$1" "$2" >> .env
    fi
  }
  set_kv CARTETHYIA_DB_MODE lite
  set_kv NODE_ENV production
  set_kv LOG_LEVEL warn
  set_kv PORT "$PORT"
  set_kv DASHBOARD_DIST "$REPO/dist/dashboard"
  set_kv CARTETHYIA_ENCRYPTION_KEY "$KEY"
  set_kv CARTETHYIA_PUBLIC_ORIGIN "$ORIGIN"
  set_kv CARTETHYIA_DATA_DIR "$ROOT/data"
  set_kv CARTETHYIA_TELEMETRY_PAYLOAD_DIR "$ROOT/data/telemetry-payloads"
  set_kv CARTETHYIA_INSTALL_ID_DIR "$ROOT/data/.cartethyia"
else
  say ".env already exists, leaving it alone"
fi

# --- 5. stop the service before touching the database ----------------------
# SQLite is single-writer: a running service holds the database file exclusively.
if command -v systemctl >/dev/null 2>&1; then
  systemctl stop cartethyia 2>/dev/null && say "stopped cartethyia" || true
fi

# --- 6. install + setup + build -------------------------------------------
say "bun install"
bun install --linker isolated --frozen-lockfile || die "bun install failed"

say "bun setup"
bun run setup --non-interactive || die "bun setup failed"

say "bun run build (a few minutes on 1 vCPU)"
bun run build || die "build failed"

[ -f dist/main.js ] || die "dist/main.js missing after build"

# --- 7. systemd ------------------------------------------------------------
if command -v systemctl >/dev/null 2>&1 && [ -d /etc/systemd/system ]; then
  say "installing systemd unit"
  cat > /etc/systemd/system/cartethyia.service <<EOF
[Unit]
Description=Cartethyia AI Gateway
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$REPO
EnvironmentFile=$REPO/.env
Environment=PATH=$(dirname "$BUN"):/usr/local/bin:/usr/bin:/bin
ExecStart=$BUN run $REPO/dist/main.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=cartethyia

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable cartethyia
  systemctl restart cartethyia

  ACTUAL_PORT=$(grep -E '^PORT=' .env | cut -d= -f2)
  say "waiting for /health/ready on port $ACTUAL_PORT"
  healthy=0
  for _ in $(seq 1 40); do
    if curl -fsS "http://127.0.0.1:${ACTUAL_PORT}/health/ready" >/dev/null 2>&1; then
      healthy=1; break
    fi
    sleep 3
  done
  if [ "$healthy" != "1" ]; then
    die "service did not become healthy; check: journalctl -u cartethyia -n 50"
  fi
  say "healthy"
else
  ACTUAL_PORT=$(grep -E '^PORT=' .env | cut -d= -f2)
fi

cat <<EOF

  Cartethyia installed (Lite).

    root     $ROOT
    port     $ACTUAL_PORT
    console  $ORIGIN/console
    status   systemctl status cartethyia
    logs     journalctl -u cartethyia -f

  NEXT — first boot is a wizard and has NOT run yet. Either open the console
  and complete it, or seed it now:

    curl -s http://127.0.0.1:$ACTUAL_PORT/console/api/auth/first-boot
    curl -s -X POST http://127.0.0.1:$ACTUAL_PORT/console/api/auth/setup \\
      -H 'content-type: application/json' \\
      -d '{"password":"CHANGE-ME","username":"admin"}'

  To have the default gateway API key seeded, set CARTETHYIA_API_KEY in .env
  and reset the database BEFORE running setup — the key is only read during
  first boot.
EOF
