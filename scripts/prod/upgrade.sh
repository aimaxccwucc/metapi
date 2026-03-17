#!/usr/bin/env bash
set -euo pipefail

# One-click upgrade for local production runtime.
# - Builds new image from /home/tanmw/metapi
# - Backs up /home/tanmw/metapi-deploy/{docker-compose.yml,.env,data}
# - Recreates container and runs health checks
# - Auto-rollbacks on failure

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOY_DIR="${DEPLOY_DIR:-/home/tanmw/metapi-deploy}"
SERVICE_NAME="${SERVICE_NAME:-metapi}"
CONTAINER_NAME="${CONTAINER_NAME:-metapi}"
HOST_URL="${HOST_URL:-http://127.0.0.1:4000/}"
PUBLIC_URL="${PUBLIC_URL:-https://metapi.aimax.ccwu.cc/sites}"

# Image tag used by scripts/dev/deploy-prod-local.sh
IMAGE_TAG="${IMAGE_TAG:-metapi-local:latest}"

timestamp() {
  date +%Y%m%d-%H%M%S
}

die() {
  echo "[error] $*" >&2
  exit 1
}

require_cmd() {
  local name="$1"
  command -v "$name" >/dev/null 2>&1 || die "$name not found"
}

copy_tree() {
  local src="$1"
  local dest="$2"
  if [ ! -e "$src" ]; then
    return 0
  fi
  mkdir -p "$(dirname "$dest")"
  if cp -al "$src" "$dest" 2>/dev/null; then
    return 0
  fi
  cp -a "$src" "$dest"
}

health_check() {
  local url="$1"
  local name="$2"
  echo "[check] $name: $url"
  curl -fsS -I --max-time 20 "$url" | sed -n '1,6p'
}

require_cmd docker
require_cmd curl

if [ ! -d "$DEPLOY_DIR" ]; then
  die "DEPLOY_DIR not found: $DEPLOY_DIR"
fi

if [ ! -f "$DEPLOY_DIR/docker-compose.yml" ]; then
  die "missing $DEPLOY_DIR/docker-compose.yml"
fi

cd "$DEPLOY_DIR"

BACKUP_ROOT="$DEPLOY_DIR/backups"
BACKUP_ID="upgrade-$(timestamp)"
BACKUP_DIR="$BACKUP_ROOT/$BACKUP_ID"

mkdir -p "$BACKUP_DIR"

echo "[1/8] Capture current runtime state"
OLD_COMPOSE_SHA256="$(sha256sum docker-compose.yml | awk '{print $1}')"
OLD_ENV_SHA256=""
if [ -f .env ]; then
  OLD_ENV_SHA256="$(sha256sum .env | awk '{print $1}')"
fi

OLD_CONTAINER_ID=""
OLD_IMAGE_REF=""
if docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  OLD_CONTAINER_ID="$(docker inspect "$CONTAINER_NAME" --format '{{.Id}}')"
  OLD_IMAGE_REF="$(docker inspect "$CONTAINER_NAME" --format '{{.Config.Image}}')"
fi

echo "compose_sha256=$OLD_COMPOSE_SHA256" >"$BACKUP_DIR/state.env"
echo "env_sha256=$OLD_ENV_SHA256" >>"$BACKUP_DIR/state.env"
echo "container_id=$OLD_CONTAINER_ID" >>"$BACKUP_DIR/state.env"
echo "image_ref=$OLD_IMAGE_REF" >>"$BACKUP_DIR/state.env"
echo "image_tag=$IMAGE_TAG" >>"$BACKUP_DIR/state.env"

echo "[2/8] Backup deploy files and data to $BACKUP_DIR"
copy_tree "$DEPLOY_DIR/docker-compose.yml" "$BACKUP_DIR/docker-compose.yml"
copy_tree "$DEPLOY_DIR/.env" "$BACKUP_DIR/.env"
copy_tree "$DEPLOY_DIR/data" "$BACKUP_DIR/data"

# Hint: if Docker Hub is unreachable and the base image isn't present locally,
# the build step may fail. You can pre-pull or override it:
#   RUNTIME_BASE_IMAGE=node:22-bookworm-slim bash scripts/prod/upgrade.sh

rollback() {
  echo "[rollback] Starting rollback using backup: $BACKUP_DIR" >&2

  if [ -f "$BACKUP_DIR/docker-compose.yml" ]; then
    cp -a "$BACKUP_DIR/docker-compose.yml" "$DEPLOY_DIR/docker-compose.yml"
  fi
  if [ -f "$BACKUP_DIR/.env" ]; then
    cp -a "$BACKUP_DIR/.env" "$DEPLOY_DIR/.env"
  fi

  if [ -d "$BACKUP_DIR/data" ]; then
    # Replace data directory without rm -rf (some environments block rm).
    local tmp_dir prev_dir
    tmp_dir="$DEPLOY_DIR/data.rollback-tmp.$(timestamp)"
    prev_dir="$DEPLOY_DIR/data.pre-rollback.$(timestamp)"
    cp -a "$BACKUP_DIR/data" "$tmp_dir"
    if [ -e "$DEPLOY_DIR/data" ]; then
      mv "$DEPLOY_DIR/data" "$prev_dir" || true
    fi
    mv "$tmp_dir" "$DEPLOY_DIR/data"
  fi

  # Best-effort: if old image ref exists, pin compose to it.
  if [ -n "$OLD_IMAGE_REF" ]; then
    sed -i "s|^\([[:space:]]*image:[[:space:]]*\).*|\1$OLD_IMAGE_REF|" "$DEPLOY_DIR/docker-compose.yml" || true
  fi

  cd "$DEPLOY_DIR"
  docker compose up -d --force-recreate "$SERVICE_NAME" || true
  echo "[rollback] Done" >&2
}

trap 'rollback' ERR

echo "[3/8] Pre-upgrade health checks"
health_check "$HOST_URL" "host"
health_check "$PUBLIC_URL" "public"

echo "[4/8] Build and deploy new version"
cd "$ROOT_DIR"
bash scripts/dev/deploy-prod-local.sh

echo "[5/8] Post-upgrade health checks"
health_check "$HOST_URL" "host"
health_check "$PUBLIC_URL" "public"

echo "[6/8] Show container status"
cd "$DEPLOY_DIR"
docker compose ps "$SERVICE_NAME"
docker inspect "$CONTAINER_NAME" --format '{{.Id}} {{.Image}} {{.Config.Image}}'

echo "[7/8] Mark upgrade as successful"
trap - ERR
echo "success=1" >>"$BACKUP_DIR/state.env"

echo "[8/8] Completed"
echo "Backup saved at: $BACKUP_DIR"
