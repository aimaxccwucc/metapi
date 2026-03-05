# syntax=docker/dockerfile:1.7
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Use CN mirrors + retries to reduce build failures on international network.
RUN sed -i 's|http://deb.debian.org|http://mirrors.ustc.edu.cn|g' /etc/apt/sources.list.d/debian.sources \
  && apt-get -o Acquire::Retries=5 update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

ENV PYTHON=/usr/bin/python3

COPY package.json package-lock.json ./
RUN npm config set registry https://registry.npmmirror.com
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

COPY . .
RUN npm run build
RUN --mount=type=cache,target=/root/.npm npm prune --omit=dev --no-audit --no-fund

FROM node:20-bookworm-slim

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/drizzle ./drizzle

RUN mkdir -p /app/data

EXPOSE 4000

ENV NODE_ENV=production
ENV DATA_DIR=/app/data

CMD ["sh", "-c", "node dist/server/db/migrate.js && node dist/server/index.js"]
