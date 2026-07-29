# syntax=docker/dockerfile:1

FROM oven/bun:1.3.14-alpine AS build
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY dashboard/package.json dashboard/bun.lock ./dashboard/
RUN cd dashboard && bun install --frozen-lockfile

COPY . .
RUN cd dashboard && bun run build

FROM oven/bun:1.3.14-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/app/data

RUN apk add --no-cache su-exec \
    && addgroup -S cartethyia \
    && adduser -S -G cartethyia cartethyia \
    && mkdir -p /app/data \
    && chown -R cartethyia:cartethyia /app

COPY --from=build --chown=cartethyia:cartethyia /app/package.json /app/bun.lock ./
COPY --from=build --chown=cartethyia:cartethyia /app/node_modules ./node_modules
COPY --from=build --chown=cartethyia:cartethyia /app/src ./src
COPY --from=build --chown=cartethyia:cartethyia /app/dashboard/dist ./dashboard/dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["bun", "run", "start"]
