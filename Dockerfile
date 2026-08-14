# syntax=docker/dockerfile:1
#
# One repository Dockerfile with two independently selectable targets:
#   --target runtime    Go daemon API (default)
#   --target dashboard  existing React/Vite dashboard static image
#
# The Go daemon never embeds or serves the dashboard. It exposes its HTTP API
# on port 12800; the dashboard talks to that port through its configured
# reverse-proxy/public origin.

FROM oven/bun:1.4.0-debian AS dashboard-build
WORKDIR /src/dashboard

COPY dashboard/package.json dashboard/bun.lock ./
RUN bun install --frozen-lockfile
COPY dashboard/ ./
RUN bun run build

FROM golang:1.26.5-bookworm AS daemon-build
WORKDIR /src/daemon

COPY daemon/go.mod ./
RUN go mod download
COPY daemon/ ./

ENV CGO_ENABLED=0
RUN go build -trimpath -ldflags="-s -w" -o /out/cartethyia ./cmd/cartethyia

FROM gcr.io/distroless/static-debian12:nonroot AS daemon
WORKDIR /app

ENV CARTETHYIA_LISTEN_ADDRESS=:12800 \
    CARTETHYIA_ENV=production \
    DATABASE_URL=""

EXPOSE 12800

COPY --from=daemon-build --chown=nonroot:nonroot /out/cartethyia /app/cartethyia

ENTRYPOINT ["/app/cartethyia"]

FROM nginx:1.27-alpine AS dashboard
COPY --from=dashboard-build /src/dashboard/dist /usr/share/nginx/html
EXPOSE 80

FROM daemon AS runtime
