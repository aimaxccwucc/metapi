#!/usr/bin/env bash
set -euo pipefail

# One-click canary-style upgrade for local production runtime.
# - Builds new image from /home/tanmw/metapi
# - Backs up /home/tanmw/metapi-deploy/{docker-compose.yml,.env,data}
# - Recreates container and runs staged health checks
# - Auto-rollbacks on failure

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOY_DIR="${DEPLOY_DIR:-/home/tanmw/metapi-deploy}"
SERVICE_NAME="${SERVICE_NAME:-metapi}"
CONTAINER_NAME="${CONTAINER_NAME:-metapi}"
HOST_URL="${HOST_URL:-http://127.0.0.1:4000/v1/models}"
PUBLIC_URL="${PUBLIC_URL:-https://metapi.808039.xyz/v1/models}"
HOST_WARMUP_SECONDS="${HOST_WARMUP_SECONDS:-8}"
HOST_CHECK_RETRIES="${HOST_CHECK_RETRIES:-15}"
HOST_CHECK_INTERVAL="${HOST_CHECK_INTERVAL:-2}"
PUBLIC_CHECK_RETRIES="${PUBLIC_CHECK_RETRIES:-15}"
PUBLIC_CHECK_INTERVAL="${PUBLIC_CHECK_INTERVAL:-3}"
STABLE_CHECK_ROUNDS="${STABLE_CHECK_ROUNDS:-3}"
STABLE_CHECK_INTERVAL="${STABLE_CHECK_INTERVAL:-5}"
BACKUP_KEEP_COUNT="${BACKUP_KEEP_COUNT:-2}"
CHAT_SMOKE_MODELS="${CHAT_SMOKE_MODELS:-gpt-5.4,claude-sonnet-4-6}"
CHAT_SMOKE_MAX_TIME="${CHAT_SMOKE_MAX_TIME:-35}"
HEALTH_CURL_NO_PROXY="${HEALTH_CURL_NO_PROXY:-*}"

# Image tag used by scripts/dev/deploy-prod-local.sh
IMAGE_TAG="${IMAGE_TAG:-metapi-local:latest}"

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'EOF'
Usage:
  bash scripts/prod/upgrade.sh

Optional env overrides:
  HOST_WARMUP_SECONDS=12
  HOST_CHECK_RETRIES=20
  PUBLIC_CHECK_RETRIES=20

Rollback:
  bash scripts/prod/rollback.sh latest
EOF
  exit 0
fi

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

backup_copy() {
  local src="$1"
  local dest="$2"
  if [ ! -e "$src" ]; then
    return 0
  fi
  mkdir -p "$(dirname "$dest")"
  cp -a "$src" "$dest"
}

prune_backup_dirs() {
  local keep_count="$1"
  local backup_root="$2"
  local dirs=()
  local dates=()
  local stale=()
  mapfile -t dirs < <(ls -dt "$backup_root"/upgrade-* 2>/dev/null || true)
  if [ "${#dirs[@]}" -le "$keep_count" ]; then
    return 0
  fi

  mapfile -t dates < <(
    for dir in "${dirs[@]}"; do
      base_name="$(basename "$dir")"
      backup_date="${base_name#upgrade-}"
      backup_date="${backup_date%%-*}"
      [ -n "$backup_date" ] && printf '%s\n' "$backup_date"
    done | awk '!seen[$0]++'
  )

  if [ "${#dates[@]}" -le "$keep_count" ]; then
    return 0
  fi

  local keep_dates=()
  keep_dates=("${dates[@]:0:$keep_count}")

  for dir in "${dirs[@]}"; do
    local base_name backup_date should_keep
    base_name="$(basename "$dir")"
    backup_date="${base_name#upgrade-}"
    backup_date="${backup_date%%-*}"
    should_keep=0
    for keep_date in "${keep_dates[@]}"; do
      if [ "$backup_date" = "$keep_date" ]; then
        should_keep=1
        break
      fi
    done
    if [ "$should_keep" -eq 0 ]; then
      stale+=("$dir")
    fi
  done

  for dir in "${stale[@]}"; do
    [ -d "$dir" ] || continue
    rm -rf "$dir"
    echo "[cleanup] removed backup dir: $dir"
  done
}

prune_image_tags() {
  local keep_count="$1"
  local pattern="$2"
  local tags=()
  local stale=()
  mapfile -t tags < <(docker image ls "$pattern" --format '{{.Repository}}:{{.Tag}}' | grep -v ':latest$' | sort -t: -k2,2r || true)
  if [ "${#tags[@]}" -le "$keep_count" ]; then
    return 0
  fi
  stale=("${tags[@]:$keep_count}")
  for tag in "${stale[@]}"; do
    [ -n "$tag" ] || continue
    docker image rm "$tag" >/dev/null 2>&1 || true
    echo "[cleanup] removed image tag: $tag"
  done
}

health_check() {
  local url="$1"
  local name="$2"
  echo "[check] $name: $url"
  if curl --noproxy "$HEALTH_CURL_NO_PROXY" -sS --connect-timeout 5 --max-time 20 "$url" >/dev/null 2>&1; then
    return 0
  fi

  # Some hosts have flaky IPv6 connectivity to Cloudflare. Retry forcing IPv4
  # for hostnames, but avoid forcing IPv4 on IPv6 literals like http://[::1]/.
  if [[ "$url" != http://[* && "$url" != https://[* ]]; then
    echo "[check] $name retry with IPv4"
    curl --noproxy "$HEALTH_CURL_NO_PROXY" -4 -sS --connect-timeout 5 --max-time 20 "$url" >/dev/null 2>&1
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

stable_window_check() {
  local url="$1"
  local name="$2"
  local rounds="$3"
  local interval="$4"
  local round
  for round in $(seq 1 "$rounds"); do
    health_check "$url" "$name stable $round/$rounds"
    if [ "$round" -lt "$rounds" ]; then
      sleep "$interval"
    fi
  done
}

run_chat_smoke_check() {
  local models_csv="$1"
  local max_time="$2"
  local env_file="$DEPLOY_DIR/.env"
  [ -f "$env_file" ] || die "missing $env_file"

  local proxy_token
  proxy_token="$(awk -F= '$1=="PROXY_TOKEN" {sub(/^[^=]*=/, ""); print substr($0, index($0,$2))}' "$env_file" | tail -n 1 | tr -d '\r')"
  [ -n "$proxy_token" ] || die "PROXY_TOKEN missing in $env_file"

  IFS=',' read -r -a models <<< "$models_csv"
  local model
  for model in "${models[@]}"; do
    model="$(printf '%s' "$model" | xargs)"
    [ -n "$model" ] || continue
    echo "[check] chat smoke: $model"
    local body
    body=$(printf '{"model":"%s","messages":[{"role":"user","content":"只回复OK"}],"stream":false,"max_tokens":8}' "$model")
    local tmp_body
    tmp_body="$(mktemp)"
    local code_and_time
    code_and_time=$(curl -sS -o "$tmp_body" -w '%{http_code} %{time_total}' --max-time "$max_time" \
      http://127.0.0.1:4000/v1/chat/completions \
      -H "Authorization: Bearer $proxy_token" \
      -H 'Content-Type: application/json' \
      -d "$body") || {
        cat "$tmp_body" 2>/dev/null || true
        rm -f "$tmp_body"
        die "chat smoke failed for $model"
      }
    local http_code
    http_code="${code_and_time%% *}"
    echo "[check] chat smoke result: model=$model code_time=$code_and_time"
    sed -n '1,6p' "$tmp_body"
    rm -f "$tmp_body"
    [ "$http_code" = "200" ] || die "chat smoke returned HTTP $http_code for $model"
  done
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
OLD_IMAGE_ID=""
ROLLBACK_IMAGE_TAG=""
if docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  OLD_CONTAINER_ID="$(docker inspect "$CONTAINER_NAME" --format '{{.Id}}')"
  OLD_IMAGE_REF="$(docker inspect "$CONTAINER_NAME" --format '{{.Config.Image}}')"
  OLD_IMAGE_ID="$(docker inspect "$CONTAINER_NAME" --format '{{.Image}}')"
  if [ -n "$OLD_IMAGE_ID" ]; then
    ROLLBACK_IMAGE_TAG="metapi-local:rollback-$(timestamp)"
    docker tag "$OLD_IMAGE_ID" "$ROLLBACK_IMAGE_TAG"
  fi
fi

echo "compose_sha256=$OLD_COMPOSE_SHA256" >"$BACKUP_DIR/state.env"
echo "env_sha256=$OLD_ENV_SHA256" >>"$BACKUP_DIR/state.env"
echo "container_id=$OLD_CONTAINER_ID" >>"$BACKUP_DIR/state.env"
echo "image_ref=$OLD_IMAGE_REF" >>"$BACKUP_DIR/state.env"
echo "image_id=$OLD_IMAGE_ID" >>"$BACKUP_DIR/state.env"
echo "rollback_image_tag=$ROLLBACK_IMAGE_TAG" >>"$BACKUP_DIR/state.env"
echo "image_tag=$IMAGE_TAG" >>"$BACKUP_DIR/state.env"

echo "[2/8] Backup deploy files and data to $BACKUP_DIR"
backup_copy "$DEPLOY_DIR/docker-compose.yml" "$BACKUP_DIR/docker-compose.yml"
backup_copy "$DEPLOY_DIR/.env" "$BACKUP_DIR/.env"
backup_copy "$DEPLOY_DIR/data" "$BACKUP_DIR/data"

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

  # Best-effort: pin compose to an immutable rollback tag first.
  if [ -n "$ROLLBACK_IMAGE_TAG" ]; then
    sed -i "/^[[:space:]]*$SERVICE_NAME:[[:space:]]*$/,/^[[:space:]]*[A-Za-z0-9_.-]\+:[[:space:]]*$/ s|^\([[:space:]]*image:[[:space:]]*\).*|\1$ROLLBACK_IMAGE_TAG|" "$DEPLOY_DIR/docker-compose.yml" || true
  elif [ -n "$OLD_IMAGE_REF" ]; then
    sed -i "/^[[:space:]]*$SERVICE_NAME:[[:space:]]*$/,/^[[:space:]]*[A-Za-z0-9_.-]\+:[[:space:]]*$/ s|^\([[:space:]]*image:[[:space:]]*\).*|\1$OLD_IMAGE_REF|" "$DEPLOY_DIR/docker-compose.yml" || true
  fi

  cd "$DEPLOY_DIR"
  docker compose up -d --force-recreate "$SERVICE_NAME" || true
  echo "[rollback] Done" >&2
}

UPGRADE_SUCCESS=0
on_exit() {
  local status=$?
  if [ "$status" -ne 0 ] && [ "$UPGRADE_SUCCESS" -ne 1 ]; then
    rollback
  fi
}

trap 'on_exit' EXIT

echo "[3/8] Pre-upgrade health checks"
health_check "$HOST_URL" "host"
health_check "$PUBLIC_URL" "public"

echo "[4/8] Build and deploy new version"
cd "$ROOT_DIR"
SKIP_POST_DEPLOY_CHECKS=1 bash scripts/dev/deploy-prod-local.sh

echo "[5/8] Post-upgrade health checks"
echo "[canary] Waiting ${HOST_WARMUP_SECONDS}s for container warm-up"
sleep "$HOST_WARMUP_SECONDS"
wait_for_health "$HOST_URL" "host" "$HOST_CHECK_RETRIES" "$HOST_CHECK_INTERVAL"
wait_for_health "$PUBLIC_URL" "public" "$PUBLIC_CHECK_RETRIES" "$PUBLIC_CHECK_INTERVAL"
stable_window_check "$HOST_URL" "host" "$STABLE_CHECK_ROUNDS" "$STABLE_CHECK_INTERVAL"
stable_window_check "$PUBLIC_URL" "public" "$STABLE_CHECK_ROUNDS" "$STABLE_CHECK_INTERVAL"
run_chat_smoke_check "$CHAT_SMOKE_MODELS" "$CHAT_SMOKE_MAX_TIME"

echo "[6/8] Show container status"
cd "$DEPLOY_DIR"
docker compose ps "$SERVICE_NAME"
docker inspect "$CONTAINER_NAME" --format '{{.Id}} {{.Image}} {{.Config.Image}}'

echo "[7/8] Mark upgrade as successful"
UPGRADE_SUCCESS=1
trap - EXIT
echo "success=1" >>"$BACKUP_DIR/state.env"

echo "[7.5/8] Prune old backups"
prune_backup_dirs "$BACKUP_KEEP_COUNT" "$BACKUP_ROOT"
prune_image_tags "$BACKUP_KEEP_COUNT" 'metapi-local:[0-9]*'
prune_image_tags "$BACKUP_KEEP_COUNT" 'metapi-local:rollback-*'

echo "[8/8] Completed"
echo "Backup saved at: $BACKUP_DIR"
