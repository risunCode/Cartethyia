# Cartethyia multi-stage production Dockerfile
# Build the backend and dashboard together so the runtime image always serves
# a matched application/static-assets version.

FROM --platform=linux/amd64 oven/bun:1.4.2-debian@sha256:53710ce0f14eef8312521c586a7ae1d9aeab4011840f09f1966073b68fc2e2ab AS builder

WORKDIR /build

# Copy manifests first so dependency installation remains cacheable.
COPY package.json bun.lock tsconfig.json ./
COPY dashboard/package.json ./dashboard/package.json
RUN bun install --frozen-lockfile

# Copy application sources only after dependencies are installed.
COPY src ./src
COPY drizzle ./drizzle
COPY dashboard ./dashboard

# Build dashboard assets, then precompile and compile the backend.
RUN bun run dashboard:build
RUN bun run build:aot
RUN bun build --compile --minify --bytecode --target bun src/main.ts --outfile /build/dist/cartethyia

# Runtime stage: only the compiled backend, dashboard output, migrations, and
# the small health-check/entrypoint toolset are shipped.
FROM --platform=linux/amd64 debian:bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create a dedicated non-root runtime identity.
RUN groupadd -r cartethyia && useradd -r -g cartethyia cartethyia

COPY --from=builder --chown=cartethyia:cartethyia /build/drizzle/migrations ./migrations
COPY --from=builder --chown=cartethyia:cartethyia /build/dist/dashboard ./dist/dashboard
COPY --chmod=755 docker-entrypoint.sh ./entrypoint.sh
COPY --from=builder --chown=cartethyia:cartethyia /build/dist/cartethyia ./cartethyia

# The application listens on PORT (default 12800 in src/main.ts and
# .env.example). Docker sets the production runtime contract explicitly.
ENV CARTETHYIA_VERSION=2.0
ENV NODE_ENV=production
ENV PORT=12800
ENV DASHBOARD_DIST=/app/dist/dashboard
EXPOSE 12800
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f "http://localhost:${PORT:-12800}/health/ready" || exit 1
# Entrypoint remains exec-form and the application itself runs unprivileged.
USER cartethyia
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["./cartethyia"]
