#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
DEPLOY_DIR="/home/tanmw/metapi-deploy"
IMAGE_TAG="metapi-local:latest"
RUNTIME_BASE_IMAGE="${RUNTIME_BASE_IMAGE:-node:22-bookworm-slim}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found" >&2
  exit 1
fi

if [ ! -f "$DEPLOY_DIR/docker-compose.yml" ]; then
  echo "missing $DEPLOY_DIR/docker-compose.yml" >&2
  exit 1
fi

copy_tree() {
  local src="$1"
  local dest="$2"
  if cp -al "$src" "$dest" 2>/dev/null; then
    return 0
  fi
  cp -a "$src" "$dest"
}

echo "[1/6] Build local production artifacts"
cd "$ROOT_DIR"
npm run build:web
npm run build:server

if [ ! -d "$ROOT_DIR/node_modules" ]; then
  echo "missing $ROOT_DIR/node_modules; please run npm install first" >&2
  exit 1
fi

if [ ! -d "$ROOT_DIR/drizzle" ]; then
  echo "missing $ROOT_DIR/drizzle" >&2
  exit 1
fi

echo "[2/6] Prepare minimal runtime build context"
STAGE_DIR="$(mktemp -d /tmp/metapi-runtime.XXXXXX)"
trap 'rm -rf "$STAGE_DIR"' EXIT
mkdir -p "$STAGE_DIR"
copy_tree "$ROOT_DIR/dist" "$STAGE_DIR/"
copy_tree "$ROOT_DIR/node_modules" "$STAGE_DIR/"
copy_tree "$ROOT_DIR/drizzle" "$STAGE_DIR/"
cp "$ROOT_DIR/package.json" "$STAGE_DIR/package.json"

cat > "$STAGE_DIR/Dockerfile" <<EOF
FROM ${RUNTIME_BASE_IMAGE}

WORKDIR /app

COPY dist ./dist
COPY node_modules ./node_modules
COPY package.json ./
COPY drizzle ./drizzle

RUN mkdir -p /app/data

EXPOSE 4000

ENV NODE_ENV=production
ENV DATA_DIR=/app/data

CMD ["sh", "-c", "node dist/server/db/migrate.js && node dist/server/index.js"]
EOF

echo "[3/6] Build runtime image from local artifacts"
docker build -f "$STAGE_DIR/Dockerfile" -t "$IMAGE_TAG" "$STAGE_DIR"
STAMP_TAG="metapi-local:$(date +%Y%m%d-%H%M%S)"
docker tag "$IMAGE_TAG" "$STAMP_TAG"
echo "Built images: $IMAGE_TAG and $STAMP_TAG"

echo "[4/6] Ensure compose uses local image"
if ! grep -q "image: $IMAGE_TAG" "$DEPLOY_DIR/docker-compose.yml"; then
  sed -i "s|^\([[:space:]]*image:[[:space:]]*\).*|\1$IMAGE_TAG|" "$DEPLOY_DIR/docker-compose.yml"
fi

echo "[5/6] Recreate metapi container"
cd "$DEPLOY_DIR"
docker compose up -d --force-recreate metapi

echo "[6/6] Quick health checks"
sleep 2
docker compose ps metapi
curl -fsS -I --max-time 15 http://127.0.0.1:4000/ | sed -n '1,6p'
curl -fsS -I --max-time 20 https://metapi.aimax.ccwu.cc/sites | sed -n '1,8p'

echo "Deploy done"
