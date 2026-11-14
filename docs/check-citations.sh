#!/usr/bin/env bash
# Fails when a source tag such as [S39] in the docs has no entry in the sources
# appendix of docs/THREAT-MODEL.md, when an entry has no link, or when an entry
# is defined twice. An entry nobody cites is only reported.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
model="$root/docs/THREAT-MODEL.md"
texts=("$model" "$root/README.md")

# An appendix entry starts a line like: - **[S39]** words, then a link.
entry_start='^- \*\*\[S[0-9]+\]\*\*'

[ -f "$model" ] || { echo "FAIL: $model is missing" >&2; exit 1; }

defined="$(grep -Eo "$entry_start" "$model" | grep -Eo 'S[0-9]+' | sort -u || true)"
dupes="$(grep -Eo "$entry_start" "$model" | grep -Eo 'S[0-9]+' | sort | uniq -d || true)"

# Every tag used in the text, not counting the tag that opens an entry.
cited="$(for f in "${texts[@]}"; do
  [ -f "$f" ] || continue
  sed -E "s/$entry_start//" "$f" | grep -Eo '\[S[0-9]+\]' | grep -Eo 'S[0-9]+' || true
done | sort -u)"

status=0

for n in $dupes; do
  echo "FAIL: [$n] is defined more than once in the appendix" >&2
  status=1
done

for n in $cited; do
  if ! grep -qx "$n" <<<"$defined"; then
    echo "FAIL: [$n] is cited but has no appendix entry" >&2
    status=1
  fi
done

while IFS= read -r line; do
  if ! grep -q 'https\?://' <<<"$line"; then
    echo "FAIL: appendix entry has no link: ${line:0:60}" >&2
    status=1
  fi
done < <(grep -E "$entry_start" "$model" || true)

for n in $defined; do
  if ! grep -qx "$n" <<<"$cited"; then
    echo "note: [$n] is in the appendix but nothing cites it"
  fi
done

if [ "$status" -eq 0 ]; then
  echo "OK: $(wc -w <<<"$cited" | tr -d ' ') cited sources, all have appendix entries"
fi
exit "$status"
