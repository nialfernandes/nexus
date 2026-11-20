#!/usr/bin/env bash
# Tests .github/check-audit.sh by running the real script with a stand-in `npm` first on PATH, so it needs no network.
#
# The stand-in does not make up what npm says. It replays what npm 10.9.8 really printed, kept in .github/audit-fixtures/:
#   high-advisory.txt  `npm audit --omit=dev --audit-level=high` (and plain `npm audit`) in a scratch project that has semver 5.7.1 as a dependency
#   clean.txt          the same command on a project with nothing wrong, and `--omit=dev` on one whose only advisory is in a devDependency
#   no-registry.txt    the same command with --registry=http://127.0.0.1:9 (nothing listening); one line, npm's pointer to its log file on
#                      the machine that captured it, was taken out because this repository is public
# and the exit codes npm gave with them: 1 for an advisory, 0 for none, 1 when it could not ask. The one thing it replays by rule is
# that `--omit=dev` is what hides a dev-only advisory (npm printed "found 0 vulnerabilities" for it), which is why the script runs a
# second, plain `npm audit` to show it.
#
# Besides the script, it checks that the workflow runs `npm run check:audit` after `npm ci`, and that package.json wires the scripts:
# the audit itself needs the network, so only its test belongs in `npm run check`.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
checker="$here/check-audit.sh"
fixtures="$here/audit-fixtures"
workflow="$here/workflows/check.yml"

work="$(mktemp -d "${TMPDIR:-/tmp}/audit-test.XXXXXX")"
trap 'rm -r "$work"' EXIT

status=0
fail() {
  echo "FAIL: $1" >&2
  status=1
}

# The stand-in npm. It answers `npm audit` only: the call with --omit=dev is the gate, any other is the plain listing.
mkdir -p "$work/bin"
cat >"$work/bin/npm" <<'STUB'
#!/usr/bin/env bash
echo "$PWD|$*" >>"$STUB_LOG"
[ "${1:-}" = "audit" ] || { echo "stand-in npm only answers 'npm audit', got: $*" >&2; exit 99; }
if [[ " $* " == *" --omit=dev "* ]]; then
  cat "$STUB_GATE_OUT"
  exit "$STUB_GATE_STATUS"
fi
cat "$STUB_ALL_OUT"
exit "$STUB_ALL_STATUS"
STUB
chmod +x "$work/bin/npm"

# run_case <name> <gate answer file> <gate exit> <plain answer file> <plain exit>, from a folder that is not the repository root.
# Leaves what the script printed (both streams) in $out, its exit code in $code, and what the stand-in was asked in $asked.
run_case() {
  local name="$1"
  mkdir -p "$work/$name/elsewhere"
  : >"$work/$name/asked"
  set +e
  out="$(cd "$work/$name/elsewhere" && PATH="$work/bin:$PATH" STUB_LOG="$work/$name/asked" \
    STUB_GATE_OUT="$fixtures/$2" STUB_GATE_STATUS="$3" STUB_ALL_OUT="$fixtures/$4" STUB_ALL_STATUS="$5" \
    bash "$checker" 2>&1)"
  code=$?
  set -e
  asked="$(cat "$work/$name/asked")"
}

# One high advisory in a package that ships: the check fails and names the package and the advisory.
run_case prod-high high-advisory.txt 1 high-advisory.txt 1
[ "$code" -ne 0 ] || fail "prod-high: a high advisory in a shipped package passed"
grep -q 'semver' <<<"$out" || fail "prod-high: the failure did not name the package (semver)"
grep -q 'GHSA-c2qf-rxjj-qqgw' <<<"$out" || fail "prod-high: the failure did not name the advisory"
grep -q 'FAIL: a package that ships has a high or critical advisory' <<<"$out" || fail "prod-high: no line says a shipped package is at fault"

# The only advisory is in a devDependency: npm's gate sees nothing, the plain run shows it, and the check passes and prints it.
run_case dev-only clean.txt 0 high-advisory.txt 1
[ "$code" -eq 0 ] || fail "dev-only: an advisory in a devDependency failed the check (exit $code)"
grep -q 'semver' <<<"$out" || fail "dev-only: the dev-only advisory was not printed"
grep -q 'GHSA-c2qf-rxjj-qqgw' <<<"$out" || fail "dev-only: the dev-only advisory's link was not printed"
grep -q '^ok: ' <<<"$out" || fail "dev-only: no ok line"

# Nothing wrong anywhere.
run_case clean clean.txt 0 clean.txt 0
[ "$code" -eq 0 ] || fail "clean: a clean tree failed (exit $code)"
grep -q 'found 0 vulnerabilities' <<<"$out" || fail "clean: npm's own answer was not shown"

# npm could not ask the registry: no answer is a failure, and it must not claim an advisory that was never found.
run_case no-registry no-registry.txt 1 no-registry.txt 1
[ "$code" -ne 0 ] || fail "no-registry: no answer from npm passed"
grep -q 'gave no answer' <<<"$out" || fail "no-registry: the failure did not say npm gave no answer"
grep -q 'a package that ships has' <<<"$out" && fail "no-registry: it blamed a package when npm never answered"

# What it asks npm is the card's command, first, and it asks from the repository root (where package-lock.json is).
run_case asked clean.txt 0 clean.txt 0
first_call="$(head -n 1 <<<"$asked")"
[ "${first_call#*|}" = "audit --omit=dev --audit-level=high" ] || fail "the first npm call was '${first_call#*|}', not 'audit --omit=dev --audit-level=high'"
[ "${first_call%%|*}" = "$root" ] || fail "npm was run from '${first_call%%|*}', not the repository root '$root'"

# The workflow runs the audit after `npm ci` ...
install_line="$(grep -n '^        run: npm ci$' "$workflow" | head -n 1 | cut -d: -f1 || true)"
audit_line="$(grep -n '^        run: npm run check:audit$' "$workflow" | head -n 1 | cut -d: -f1 || true)"
if [ -z "$install_line" ]; then
  fail "check.yml has no 'run: npm ci' step"
elif [ -z "$audit_line" ]; then
  fail "check.yml has no 'run: npm run check:audit' step"
elif [ "$audit_line" -le "$install_line" ]; then
  fail "check.yml runs the audit (line $audit_line) before it installs (line $install_line)"
fi

# ... and package.json: check:audit is this script, and `npm run check` runs the script's test but not the audit (it needs the network).
script_of() { node -e 'console.log((require(process.argv[1]).scripts || {})[process.argv[2]] || "")' "$root/package.json" "$1"; }
[ "$(script_of check:audit)" = "bash .github/check-audit.sh" ] || fail "package.json: check:audit is '$(script_of check:audit)', not 'bash .github/check-audit.sh'"
[ "$(script_of check:audit-test)" = "bash .github/check-audit.test.sh" ] || fail "package.json: check:audit-test is '$(script_of check:audit-test)', not 'bash .github/check-audit.test.sh'"
steps_of_check=" $(script_of check | sed 's/ && / \n /g' | tr '\n' ' ') "
[[ "$steps_of_check" == *" npm run check:audit-test "* ]] || fail "package.json: 'npm run check' does not run check:audit-test"
[[ "$steps_of_check" == *" npm run check:audit "* ]] && fail "package.json: 'npm run check' runs check:audit, which needs the network"

if [ "$status" -eq 0 ]; then
  echo "check-audit: all cases behave"
fi
exit "$status"
