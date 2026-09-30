# Cartethyia multi-stage production Dockerfile
# Build the backend and dashboard together so the runtime image always serves
# a matched application/static-assets version.

FROM oven/bun:1.4.2-debian@sha256:4f6e31d1a54d6a3dd312daef655fc998101b5043d52e12592ac293ef04b9bc73 AS builder

# Bun bakes process.env.NODE_ENV into the binary at build time (scripts/build-aot.ts
# and scripts/build-binary.ts), so the value has to arrive as a build argument:
# a runtime ENV cannot change it afterwards. Default production keeps the shipped
# image's logger free of the pino-pretty worker. Pass
# --build-arg CARTETHYIA_BUILD_NODE_ENV=development for a plain-HTTP deploy, where
# a Secure session cookie would never survive the browser.
ARG CARTETHYIA_BUILD_NODE_ENV=production
ENV CARTETHYIA_BUILD_NODE_ENV=${CARTETHYIA_BUILD_NODE_ENV}

WORKDIR /build

# Copy manifests first so dependency installation remains cacheable.
COPY package.json bun.lock tsconfig.json ./
COPY dashboard/package.json ./dashboard/package.json
RUN bun install --frozen-lockfile

# Copy application sources only after dependencies are installed.
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
COPY dashboard ./dashboard

# Build dashboard assets, then precompile and compile the backend.
# The compile reads `dist/main.js` (the AOT output), not `src/main.ts`: the AOT
# plugin rewrites TypeBox into statically wired imports, and bundling the raw
# source instead leaves Elysia's lazy `require("typebox/type")` unresolved in
# the standalone binary. `scripts/build-binary.ts` also bakes `NODE_ENV` to
# production, which the binary needs to avoid the development-only `pino-pretty`
# transport whose worker cannot load in a standalone executable. `bun run build`
# performs the same three steps.
RUN bun run dashboard:build
RUN bun run build:aot
RUN bun run build:binary --outfile /build/dist/cartethyia

# Runtime stage: only the compiled backend, dashboard output, migrations, and
# the small health-check/entrypoint toolset are shipped.
FROM debian:bookworm-slim

# Mirrors the builder's choice so a runtime env read agrees with the baked one.
ARG CARTETHYIA_BUILD_NODE_ENV=production
ENV CARTETHYIA_BUILD_NODE_ENV=${CARTETHYIA_BUILD_NODE_ENV}

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    util-linux \
    && rm -rf /var/lib/apt/lists/*

# Create a dedicated non-root runtime identity. The UID/GID are pinned so the
# entrypoint can drop privileges to a known id and an operator can chown a
# bind-mounted data directory to the same numbers.
RUN groupadd -r -g 10001 cartethyia && useradd -r -u 10001 -g cartethyia cartethyia && \
    mkdir -p /app/data && chown -R cartethyia:cartethyia /app

COPY --from=builder --chown=cartethyia:cartethyia /build/migrations ./migrations
COPY --from=builder --chown=cartethyia:cartethyia /build/dist/dashboard ./dist/dashboard
COPY docker-entrypoint.sh ./entrypoint.sh
RUN chmod 755 ./entrypoint.sh
COPY --from=builder --chown=cartethyia:cartethyia /build/dist/cartethyia ./cartethyia

# Railway supplies PORT at runtime; the binary uses 12800 only as its fallback.
ENV CARTETHYIA_VERSION=2.0
ENV NODE_ENV=production
ENV DASHBOARD_DIST=/app/dist/dashboard
# The runtime user (10001) does not own the image's default HOME, so provider
# install ids go under the data directory the entrypoint already repairs.
ENV CARTETHYIA_INSTALL_ID_DIR=/app/data/.cartethyia
EXPOSE 12800
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f "http://localhost:${PORT:-12800}/health/ready" || exit 1
# The entrypoint starts as root, repairs the data-directory ownership, and
# drops to `cartethyia` via setpriv before exec'ing the application, so the
# process itself never runs as root. Setting USER here would skip that repair
# on a mounted volume.
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["./cartethyia"]
