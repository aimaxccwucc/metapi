#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_DIR"

if ! git remote get-url upstream >/dev/null 2>&1; then
  git remote add upstream https://github.com/cita-777/metapi.git
fi

git fetch origin --prune >/dev/null
git fetch upstream --prune >/dev/null

current_branch="$(git rev-parse --abbrev-ref HEAD)"
branch_ref="$current_branch"
if ! git show-ref --verify --quiet "refs/remotes/upstream/$current_branch"; then
  branch_ref="main"
fi

read -r local_vs_origin_left local_vs_origin_right < <(git rev-list --left-right --count "$branch_ref...origin/$branch_ref")
read -r local_vs_upstream_left local_vs_upstream_right < <(git rev-list --left-right --count "$branch_ref...upstream/$branch_ref")
read -r origin_vs_upstream_left origin_vs_upstream_right < <(git rev-list --left-right --count "origin/$branch_ref...upstream/$branch_ref")

echo "branch=$branch_ref"
echo "local_vs_origin ahead=$local_vs_origin_left behind=$local_vs_origin_right"
echo "local_vs_upstream ahead=$local_vs_upstream_left behind=$local_vs_upstream_right"
echo "origin_vs_upstream ahead=$origin_vs_upstream_left behind=$origin_vs_upstream_right"

echo "latest_origin=$(git rev-parse --short "origin/$branch_ref")"
echo "latest_upstream=$(git rev-parse --short "upstream/$branch_ref")"

echo "--- upstream recent commits ---"
git log --oneline --decorate --max-count=8 "upstream/$branch_ref"
