# syntax=docker/dockerfile:1

# ─── Stage 1: Build wgcf + Wireproxy from vendored source trees ──────────────
FROM golang:1.26.5-bookworm@sha256:6c5605ab3a9a9fb3c4eafe5b3d63cdbf3881caf113262b67862547b54a9db599 AS go-build
WORKDIR /build

COPY vendor/wgcf/ ./wgcf/
RUN cd wgcf && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/wgcf .

COPY vendor/wireproxy/ ./wireproxy/
RUN cd wireproxy && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/wireproxy ./cmd/wireproxy

# ─── Stage 2: Build dashboard + install deps ────────────────────────────────
FROM oven/bun:canary-debian@sha256:994ab4c38ff6391322a2264dcf11860561a8621756270e11335e097eb774965a AS build
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY dashboard/package.json dashboard/bun.lock ./dashboard/
RUN cd dashboard && bun install --frozen-lockfile

COPY . .
RUN cd dashboard && bun run build
RUN bun build --compile --minify --bytecode --target bun --outfile /out/cartethyia src/main.ts

# ─── Stage 3: Runtime ───────────────────────────────────────────────────────
FROM oven/bun:canary-debian@sha256:994ab4c38ff6391322a2264dcf11860561a8621756270e11335e097eb774965a AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/app/data

RUN apt-get update \
    && apt-get install --no-install-recommends -y \
      adduser \
      ca-certificates \
      fastfetch \
      gosu \
      speedtest-cli \
      wget \
    && rm -rf /var/lib/apt/lists/* \
    && addgroup --system cartethyia \
    && adduser --system --ingroup cartethyia cartethyia \
    && mkdir -p /app/data /app/data/warp /app/bin \
    && ln -s "$(command -v fastfetch)" /usr/local/bin/neofetch \
    && chown -R cartethyia:cartethyia /app

# Go-built Warp helpers (statically linked; no runtime Go dependency).
COPY --from=go-build --chown=cartethyia:cartethyia /out/wgcf /app/bin/wgcf
COPY --from=go-build --chown=cartethyia:cartethyia /out/wireproxy /app/bin/wireproxy

COPY --from=build --chown=cartethyia:cartethyia /out/cartethyia /app/bin/cartethyia
COPY --from=build --chown=cartethyia:cartethyia /app/dashboard/dist ./dashboard/dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh

# Cartethyia main HTTP server — Railway auto-detects this port.
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["/app/bin/cartethyia"]
