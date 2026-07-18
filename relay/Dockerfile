FROM oven/bun:1.3.11-alpine

WORKDIR /app
COPY --chown=bun:bun package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --chown=bun:bun src ./src
RUN mkdir -p /data && chown bun:bun /data

USER bun
ENV SNAPSHOT_PATH=/data/orders.json
CMD ["bun", "run", "relay"]
