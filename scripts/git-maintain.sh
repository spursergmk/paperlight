#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: scripts/git-maintain.sh <commit-message> <path> [path ...]" >&2
}

if [ "$#" -lt 2 ]; then
  usage
  exit 2
fi

message=$1
shift
paths=("$@")

root=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "Error: not inside a Git repository." >&2
  exit 2
}

if [ "$(pwd -P)" != "$(cd "$root" && pwd -P)" ]; then
  echo "Error: run this script from the repository root." >&2
  exit 2
fi

if ! git diff --cached --quiet; then
  echo "Error: the index already contains staged changes." >&2
  exit 2
fi

branch=$(git branch --show-current)
if [ -z "$branch" ]; then
  echo "Error: detached HEAD is not supported." >&2
  exit 2
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "Error: remote 'origin' is not configured." >&2
  exit 2
fi

if [ -z "$(git config user.name || true)" ] || [ -z "$(git config user.email || true)" ]; then
  echo "Error: repository Git author name/email is not configured." >&2
  exit 2
fi

staged=false
cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && [ "$staged" = true ]; then
    git reset --quiet
  fi
  exit "$status"
}
trap cleanup EXIT

git add -- "${paths[@]}"
staged=true

if git diff --cached --quiet; then
  echo "No changes to commit."
  git reset --quiet
  staged=false
  exit 0
fi

while IFS= read -r -d '' path; do
  case "$path" in
    .env.example|*/.env.example)
      ;;
    .env|*/.env|.env.*|*/.env.*|*.pdf|*.PDF|dsh_inputs/*|*/dsh_inputs/*|node_modules/*|*/node_modules/*|dist/*|*/dist/*|Paperlight.app/*|*/Paperlight.app/*|.DS_Store|*/.DS_Store)
      echo "Error: refusing to commit protected path: $path" >&2
      exit 3
      ;;
  esac
done < <(git diff --cached --name-only --diff-filter=ACMR -z)

git diff --cached --check

echo "Files to commit:"
git diff --cached --name-only

git commit -m "$message"
staged=false

if git rev-parse --abbrev-ref '@{upstream}' >/dev/null 2>&1; then
  git push
else
  git push -u origin "$branch"
fi
