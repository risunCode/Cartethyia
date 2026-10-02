# syntax=docker/dockerfile:1.7
# Alpine is the default to keep the image small. The builder uses the same musl
# family so the standalone binary matches the runtime libc.
# To use the previous Debian slim setup, replace the builder with a pinned
# `oven/bun:debian` and runtime with `debian:bookworm-slim`, then
# replace apk/user commands with apt equivalents. Verify native modules and tools.

FROM oven/bun:alpine AS builder

# Bun bakes process.env.NODE_ENV into the binary at build time (scripts/build/aot.ts
# and scripts/build/binary.ts), so the value has to arrive as a build argument:
# a runtime ENV cannot change it afterwards. Default production keeps the shipped
# image's logger free of the pino-pretty worker. Pass
# --build-arg CARTETHYIA_BUILD_NODE_ENV=development for a plain-HTTP deploy, where
# a Secure session cookie would never survive the browser.
ARG CARTETHYIA_BUILD_NODE_ENV=production
ENV CARTETHYIA_BUILD_NODE_ENV=${CARTETHYIA_BUILD_NODE_ENV}

WORKDIR /build

# Dependency layer: source changes do not invalidate Bun installation.
# Do not use BuildKit cache mounts here: Railway and other builders may not
# provide cache-mount support. The image must build with a standard builder.
COPY package.json bun.lock tsconfig.json ./
COPY dashboard/package.json ./dashboard/package.json
RUN bun install --frozen-lockfile

# Copy source contracts before dashboard typecheck: dashboard mirrors several
# backend types from src/ and cannot build against dashboard alone.
COPY src ./src
COPY dashboard ./dashboard
RUN bun run dashboard:build

# Backend build layer: AOT output is required before standalone compilation.
COPY scripts ./scripts
COPY migrations ./migrations
RUN bun run build:aot && bun run build:binary --outfile /build/dist/cartethyia

# Runtime: only the binary, dashboard assets, migrations, and entrypoint ship.
FROM alpine:latest

# Mirrors the builder's choice so a runtime env read agrees with the baked one.
ARG CARTETHYIA_BUILD_NODE_ENV=production
ENV CARTETHYIA_BUILD_NODE_ENV=${CARTETHYIA_BUILD_NODE_ENV}

WORKDIR /app

# curl powers HEALTHCHECK; util-linux provides setpriv for non-root startup.
RUN apk add --no-cache ca-certificates curl libgcc libstdc++ util-linux \
    && addgroup -S -g 10001 cartethyia \
    && adduser -S -D -H -u 10001 -G cartethyia cartethyia \
    && mkdir -p /app/data \
    && chown -R cartethyia:cartethyia /app

COPY --from=builder --chown=cartethyia:cartethyia /build/migrations ./migrations
COPY --from=builder --chown=cartethyia:cartethyia /build/dist/dashboard ./dist/dashboard
COPY docker-entrypoint.sh ./entrypoint.sh
RUN chmod 755 ./entrypoint.sh
COPY --from=builder --chown=cartethyia:cartethyia /build/dist/cartethyia ./cartethyia

ENV CARTETHYIA_VERSION=2.0 \
    NODE_ENV=production \
    DASHBOARD_DIST=/app/dist/dashboard \
    CARTETHYIA_INSTALL_ID_DIR=/app/data/.cartethyia

EXPOSE 12800
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f "http://localhost:${PORT:-12800}/health/ready" || exit 1

# Start as root so mounted data ownership can be repaired, then drop to uid 10001.
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["./cartethyia"]
