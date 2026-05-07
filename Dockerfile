ARG BUN_VERSION='1.3'
ARG PG_VERSION='17'

FROM oven/bun:${BUN_VERSION}-alpine AS bun

FROM bun AS build

WORKDIR /app

COPY package.json bun.lock tsconfig.json ./
COPY src ./src

RUN bun install --frozen-lockfile

FROM postgres:${PG_VERSION}-alpine

WORKDIR /app

RUN apk add --no-cache ca-certificates libstdc++

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/bun.lock ./
COPY --from=build /app/src ./src
COPY --from=build /app/tsconfig.json ./

ENTRYPOINT []
CMD pg_isready --dbname="$DATABASE_URL" && \
    pg_dump --version && \
    bun run src/index.ts
