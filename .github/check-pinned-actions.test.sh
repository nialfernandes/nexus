#!/usr/bin/env bash
# Tests .github/check-pinned-actions.sh by running the real script on the real workflow and on
# copies of it with one bad `uses:` line planted. The real workflow must pass; each planted
# copy must fail and name the bad line.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
checker="$here/check-pinned-actions.sh"
real="$here/workflows"

work="$(mktemp -d "${TMPDIR:-/tmp}/pinned-actions-test.XXXXXX")"
trap 'rm -r "$work"' EXIT

hash_a=11d5960a326750d5838078e36cf38b85af677262
status=0

fail() {
  echo "FAIL: $1" >&2
  status=1
}

# The workflow as committed must pass.
if ! bash "$checker" "$real" >/dev/null 2>&1; then
  fail "the real workflows in $real do not pass the check"
fi

# Plant one `uses:` line in a copy of the workflow and expect the check to fail on it.
expect_fail() {
  local name="$1" line="$2" dir="$work/$1"
  mkdir -p "$dir"
  cp "$real"/*.yml "$dir/"
  printf '      - uses: %s\n' "$line" >>"$dir/check.yml"
  if out="$(bash "$checker" "$dir" 2>&1)"; then
    fail "$name: '$line' was accepted"
  elif ! grep -qF "$line" <<<"$out"; then
    fail "$name: the check failed but did not name '$line'"
  fi
}

# Plant one `uses:` line that must be accepted.
expect_pass() {
  local name="$1" line="$2" dir="$work/$1"
  mkdir -p "$dir"
  cp "$real"/*.yml "$dir/"
  printf '      - uses: %s\n' "$line" >>"$dir/check.yml"
  if ! bash "$checker" "$dir" >/dev/null 2>&1; then
    fail "$name: '$line' was refused"
  fi
}

expect_fail major-tag "actions/checkout@v4"
expect_fail exact-tag "actions/setup-node@v4.4.0"
expect_fail branch "actions/checkout@main"
expect_fail short-hash "actions/checkout@${hash_a:0:7}"
expect_fail long-hash "actions/checkout@${hash_a}0"
expect_fail upper-hash "actions/checkout@${hash_a^^}"
expect_fail no-ref "actions/checkout"
expect_fail quoted-tag "'actions/checkout@v4'"
expect_fail docker-tag "docker://alpine:3.20"
expect_fail reusable-workflow "octo/repo/.github/workflows/x.yml@v1"
expect_fail tag-with-comment "actions/checkout@v4 # ${hash_a}"

expect_pass pinned "actions/checkout@${hash_a} # v4.4.0"
expect_pass pinned-quoted "\"actions/checkout@${hash_a}\" # v4.4.0"
expect_pass local-action "./.github/actions/thing"

# A `uses:` that only appears in a comment is not a step.
mkdir -p "$work/comment"
cp "$real"/*.yml "$work/comment/"
printf '# uses: actions/checkout@v4\n' >>"$work/comment/check.yml"
bash "$checker" "$work/comment" >/dev/null 2>&1 || fail "a commented-out uses: line was refused"

# A step that is not the first key of a list item is still found.
mkdir -p "$work/nested"
cp "$real"/*.yml "$work/nested/"
printf '        uses: actions/checkout@v4\n' >>"$work/nested/check.yml"
bash "$checker" "$work/nested" >/dev/null 2>&1 && fail "an indented uses: line with a tag was accepted"

# A folder with no workflow files is an error, not a pass.
mkdir -p "$work/empty"
bash "$checker" "$work/empty" >/dev/null 2>&1 && fail "a folder with no workflow files was accepted"

if [ "$status" -eq 0 ]; then
  echo "check-pinned-actions: all cases behave"
fi
exit "$status"
