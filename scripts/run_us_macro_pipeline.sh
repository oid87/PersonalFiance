#!/usr/bin/env bash
# One optional CI unit: either publish all macro paths or restore their HEAD state.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

summary=data/us_macro_diagnostic.json
archive=data/us_macro_archive
snapshots=data/us_macro_diagnostic_snapshots
local_date="$(TZ=Asia/Taipei date +%Y-%m-%d)"
today_snapshot="$snapshots/${local_date:0:4}/$local_date.json"

# The committed snapshot, rather than a leftover working-tree file, controls the skip.
if git cat-file -e "HEAD:$today_snapshot" 2>/dev/null; then
  echo "::notice::US macro snapshot already committed for Taipei $local_date; skipping fetch and capture"
  exit 0
fi

rollback_macro() {
  local status=$?
  trap - ERR
  for path in "$summary" "$archive" "$snapshots"; do
    if git cat-file -e "HEAD:$path" 2>/dev/null; then
      git restore --source=HEAD --staged --worktree -- "$path"
    else
      git rm -rfq --cached --ignore-unmatch -- "$path" || true
      rm -rf -- "$path"
    fi
  done
  git clean -fdq -- "$archive" "$snapshots"
  echo "::warning::US macro pipeline failed (exit $status); macro data restored to HEAD" >&2
  exit 1
}
trap rollback_macro ERR

python3 scripts/fetch_us_macro_diagnostic.py
python3 scripts/validate_us_macro.py
as_of="$(python3 -c 'import json; print(json.load(open("data/us_macro_diagnostic.json"))["as_of"])')"
node scripts/capture_us_macro_diagnostic.mjs --as-of "$as_of"
node scripts/validate_us_macro_diagnostic_snapshots.mjs
