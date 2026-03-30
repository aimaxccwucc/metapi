#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOY_DIR="${DEPLOY_DIR:-/home/tanmw/metapi-deploy}"
SERVICE_NAME="${SERVICE_NAME:-metapi}"
CONTAINER_NAME="${CONTAINER_NAME:-metapi}"
HOST_URL="${HOST_URL:-http://127.0.0.1:4000/accounts}"
PUBLIC_URL="${PUBLIC_URL:-https://metapi.808039.xyz/accounts}"
HOST_WARMUP_SECONDS="${HOST_WARMUP_SECONDS:-8}"
HOST_CHECK_RETRIES="${HOST_CHECK_RETRIES:-15}"
HOST_CHECK_INTERVAL="${HOST_CHECK_INTERVAL:-2}"
PUBLIC_CHECK_RETRIES="${PUBLIC_CHECK_RETRIES:-15}"
PUBLIC_CHECK_INTERVAL="${PUBLIC_CHECK_INTERVAL:-3}"

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

health_check() {
  local url="$1"
  local name="$2"
  echo "[check] $name: $url"
  if curl -fsS -I --connect-timeout 5 --max-time 20 "$url" | sed -n '1,6p'; then
    return 0
  fi
  if [[ "$url" != http://[* && "$url" != https://[* ]]; then
    echo "[check] $name retry with IPv4"
    curl -4 -fsS -I --connect-timeout 5 --max-time 20 "$url" | sed -n '1,6p'
    return 0
  fi
  return 1
}

wait_for_health() {
  local url="$1"
  local name="$2"
  local retries="$3"
  local interval="$4"
  local attempt
  for attempt in $(seq 1 "$retries"); do
    if health_check "$url" "$name (attempt $attempt/$retries)"; then
      return 0
    fi
    if [ "$attempt" -lt "$retries" ]; then
      sleep "$interval"
    fi
  done
  return 1
}

resolve_backup_dir() {
  local input="${1:-latest}"
  local backup_root="$DEPLOY_DIR/backups"

  if [ "$input" = "latest" ]; then
    local latest
    latest="$(ls -dt "$backup_root"/upgrade-* 2>/dev/null | head -n 1 || true)"
    [ -n "$latest" ] || die "no upgrade backups found in $backup_root"
    printf '%s\n' "$latest"
    return 0
  fi

  if [ -d "$input" ]; then
    printf '%s\n' "$input"
    return 0
  fi

  if [ -d "$backup_root/$input" ]; then
    printf '%s\n' "$backup_root/$input"
    return 0
  fi

  die "backup directory not found: $input"
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'EOF'
Usage:
  bash scripts/prod/rollback.sh [latest|backup-id|/absolute/path]

Examples:
  bash scripts/prod/rollback.sh
  bash scripts/prod/rollback.sh upgrade-20260323-125352
  bash scripts/prod/rollback.sh /home/tanmw/metapi-deploy/backups/upgrade-20260323-125352
EOF
  exit 0
fi

require_cmd docker
require_cmd curl

[ -d "$DEPLOY_DIR" ] || die "DEPLOY_DIR not found: $DEPLOY_DIR"
[ -f "$DEPLOY_DIR/docker-compose.yml" ] || die "missing $DEPLOY_DIR/docker-compose.yml"

BACKUP_DIR="$(resolve_backup_dir "${1:-latest}")"
[ -d "$BACKUP_DIR" ] || die "backup dir missing: $BACKUP_DIR"
[ -f "$BACKUP_DIR/state.env" ] || die "missing $BACKUP_DIR/state.env"

# shellcheck disable=SC1090
source "$BACKUP_DIR/state.env"

echo "[1/5] Restoring deploy files from $BACKUP_DIR"
[ -f "$BACKUP_DIR/docker-compose.yml" ] && cp -a "$BACKUP_DIR/docker-compose.yml" "$DEPLOY_DIR/docker-compose.yml"
[ -f "$BACKUP_DIR/.env" ] && cp -a "$BACKUP_DIR/.env" "$DEPLOY_DIR/.env"

if [ -d "$BACKUP_DIR/data" ]; then
  echo "[2/5] Restoring data directory"
  tmp_dir="$DEPLOY_DIR/data.rollback-restore.$(timestamp)"
  prev_dir="$DEPLOY_DIR/data.pre-rollback.$(timestamp)"
  cp -a "$BACKUP_DIR/data" "$tmp_dir"
  if [ -e "$DEPLOY_DIR/data" ]; then
    mv "$DEPLOY_DIR/data" "$prev_dir" || true
  fi
  mv "$tmp_dir" "$DEPLOY_DIR/data"
else
  echo "[2/5] Skip data restore (backup has no data directory)"
fi

echo "[3/5] Pinning rollback image"
if [ -n "${rollback_image_tag:-}" ]; then
  sed -i "s|^\([[:space:]]*image:[[:space:]]*\).*|\1${rollback_image_tag}|" "$DEPLOY_DIR/docker-compose.yml"
elif [ -n "${image_ref:-}" ]; then
  sed -i "s|^\([[:space:]]*image:[[:space:]]*\).*|\1${image_ref}|" "$DEPLOY_DIR/docker-compose.yml"
else
  echo "[warn] No rollback image recorded, keeping compose image as-is"
fi

echo "[4/5] Recreating service"
cd "$DEPLOY_DIR"
docker compose up -d --force-recreate "$SERVICE_NAME"
docker compose ps "$SERVICE_NAME"
docker inspect "$CONTAINER_NAME" --format '{{.Id}} {{.Image}} {{.Config.Image}}'

echo "[5/5] Health checks"
echo "[rollback] Waiting ${HOST_WARMUP_SECONDS}s for container warm-up"
sleep "$HOST_WARMUP_SECONDS"
wait_for_health "$HOST_URL" "host" "$HOST_CHECK_RETRIES" "$HOST_CHECK_INTERVAL"
wait_for_health "$PUBLIC_URL" "public" "$PUBLIC_CHECK_RETRIES" "$PUBLIC_CHECK_INTERVAL"

echo "Rollback completed: $BACKUP_DIR"
