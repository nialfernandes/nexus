#!/usr/bin/env bash
# Fails when a `uses:` line in a workflow does not name its action by a full 40-character
# commit hash. A tag such as `@v4` can be moved to other code, and that code would then run in
# CI. Put the tag in a trailing comment instead: `uses: actions/checkout@<hash> # v4.4.0`.
# An action in this repository (`uses: ./path`) has no tag to move and is left alone.
#
# Usage: check-pinned-actions.sh [folder of workflow files]   (default: .github/workflows)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dir="${1:-$here/workflows}"

[ -d "$dir" ] || { echo "FAIL: $dir is not a folder" >&2; exit 1; }

shopt -s nullglob
files=("$dir"/*.yml "$dir"/*.yaml)
if [ "${#files[@]}" -eq 0 ]; then
  echo "FAIL: no workflow files in $dir" >&2
  exit 1
fi

# A step line is `uses: x` or `- uses: x`; a line that starts with # is a comment.
uses_line='^[[:space:]]*(-[[:space:]]+)?uses:[[:space:]]*(.*)$'
pinned='^[^@[:space:]]+@[0-9a-f]{40}$'

status=0
checked=0

for file in "${files[@]}"; do
  n=0
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    [[ "$line" =~ $uses_line ]] || continue
    value="${BASH_REMATCH[2]}"
    value="${value%%[[:space:]]#*}"                       # drop a trailing comment
    value="${value#"${value%%[![:space:]]*}"}"            # trim leading space
    value="${value%"${value##*[![:space:]]}"}"            # trim trailing space
    value="${value#[\"\']}"; value="${value%[\"\']}"      # drop surrounding quotes
    checked=$((checked + 1))
    [[ "$value" == ./* ]] && continue
    if ! [[ "$value" =~ $pinned ]]; then
      echo "FAIL: ${file#"$PWD"/}:$n is not pinned to a 40-character commit hash: ${line#"${line%%[![:space:]]*}"}" >&2
      status=1
    fi
  done <"$file"
done

if [ "$checked" -eq 0 ]; then
  echo "FAIL: no uses: line in $dir, so nothing was checked" >&2
  exit 1
fi

if [ "$status" -eq 0 ]; then
  echo "ok: $checked uses: line(s) are pinned to a commit hash"
fi
exit "$status"
