#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
DEPLOY_DIR="/home/tanmw/metapi-deploy"
IMAGE_TAG="metapi-local:latest"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found" >&2
  exit 1
fi

if [ ! -f "$DEPLOY_DIR/docker-compose.yml" ]; then
  echo "missing $DEPLOY_DIR/docker-compose.yml" >&2
  exit 1
fi

echo "[1/5] Build runtime image from local source"
TMP_DOCKERFILE="$(mktemp /tmp/metapi.Dockerfile.prod.XXXXXX)"
trap 'rm -f "$TMP_DOCKERFILE"' EXIT

awk '
  NR==1 && $0 ~ /^# syntax=/ {next}
  {
    gsub(/RUN --mount=type=cache,target=\/root\/.npm npm ci --no-audit --no-fund/,"RUN npm ci --no-audit --no-fund");
    gsub(/RUN --mount=type=cache,target=\/root\/.npm npm prune --omit=dev --no-audit --no-fund/,"RUN npm prune --omit=dev --no-audit --no-fund");
    print
  }
' "$ROOT_DIR/docker/Dockerfile" > "$TMP_DOCKERFILE"

DOCKER_BUILDKIT=0 docker build -f "$TMP_DOCKERFILE" -t "$IMAGE_TAG" "$ROOT_DIR"

STAMP_TAG="metapi-local:$(date +%Y%m%d-%H%M%S)"
docker tag "$IMAGE_TAG" "$STAMP_TAG"
echo "Built images: $IMAGE_TAG and $STAMP_TAG"

echo "[2/5] Ensure compose uses local image"
if ! grep -q "image: $IMAGE_TAG" "$DEPLOY_DIR/docker-compose.yml"; then
  sed -i "s|^\([[:space:]]*image:[[:space:]]*\).*|\1$IMAGE_TAG|" "$DEPLOY_DIR/docker-compose.yml"
fi

echo "[3/5] Recreate metapi container"
cd "$DEPLOY_DIR"
docker compose up -d metapi

echo "[4/5] Wait and show service status"
sleep 2
docker compose ps metapi

echo "[5/5] Quick health checks"
curl -fsS -I --max-time 15 http://127.0.0.1:4000/ | sed -n '1,6p'
curl -fsS -I --max-time 20 https://metapi.aimax.ccwu.cc/sites | sed -n '1,8p'

echo "Deploy done"
