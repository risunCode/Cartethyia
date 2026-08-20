# syntax=docker/dockerfile:1
#
# One repository Dockerfile with independently selectable targets:
#   --target runtime         Go daemon API (default)
#   --target dashboard       static SPA image served by nginx
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

FROM golang:1.26.5-bookworm AS router-build
WORKDIR /src/router

COPY router/go.mod ./
RUN go mod download
COPY router/ ./

ENV CGO_ENABLED=0 \
    GOFLAGS=-buildvcs=false
RUN go build -trimpath -ldflags="-s -w" -o /out/cartethyia ./cmd/cartethyia

FROM alpine:3.22 AS router
RUN apk add --no-cache ca-certificates \
    && addgroup -S -g 10001 cartethyia \
    && adduser -S -D -H -u 10001 -G cartethyia cartethyia
WORKDIR /app

ENV CARTETHYIA_LISTEN_ADDRESS=:12800 \
    CARTETHYIA_ENV=production

EXPOSE 12800

COPY --from=router-build /out/cartethyia /app/cartethyia

USER cartethyia
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:12800/health || exit 1
ENTRYPOINT ["/app/cartethyia"]

FROM nginx:1.27-alpine AS dashboard
COPY --from=dashboard-build /src/dashboard/dist /usr/share/nginx/html
COPY deploy/docker/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80

FROM router AS runtime
