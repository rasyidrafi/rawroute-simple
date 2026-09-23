FROM oven/bun:1.4.2 AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM dependencies AS build
COPY . .
RUN bun run build

FROM oven/bun:1.4.2 AS production-dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.2 AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3001 \
    RAWROUTE_DATA_DIR=/data \
    DATABASE_URL=file:/data/rawroute.db

COPY --from=production-dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/dist ./dist
RUN install -d -o bun -g bun /data

WORKDIR /app/dist
USER bun
EXPOSE 3001
CMD ["bun", "index.js"]
