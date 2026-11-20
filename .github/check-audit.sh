#!/usr/bin/env bash
# Fails when a package that ships has a high or critical advisory, as `npm audit` knows it today.
#
# "Ships" means what `npm audit --omit=dev` looks at: the dependencies of the packages, not their devDependencies.
# That is the encryption library and everything the plugin, the server and the agent library carry. A build or test tool
# (esbuild, vitest, miniflare) is a devDependency and reaches nobody's keys, so an advisory in one is printed for a person
# to read and does not fail the check.
#
# It runs npm twice:
#   1. `npm audit --omit=dev --audit-level=high` decides. npm exits 1 for an advisory at that level or above in what ships.
#   2. `npm audit` is only printed. `--omit=dev` hides dev-only advisories (npm prints "found 0 vulnerabilities" for them),
#      so this second run is the only way to show them. Its exit code is ignored.
#
# It needs the network: npm sends the lockfile's package list to the registry. It is therefore not part of `npm run check`
# (which has to run on a machine with Node and nothing else); .github/workflows/check.yml runs it as a step of its own and
# `npm run check:audit` runs it by hand. If npm cannot get an answer (registry down, no network) the check fails too: no
# answer is not the same as no advisory.
#
# Usage: check-audit.sh      (from any folder; it works at the repository root, where package-lock.json is)
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here/.." || { echo "FAIL: cannot enter the repository root from $here" >&2; exit 1; }

[ -f package-lock.json ] || { echo "FAIL: no package-lock.json at $PWD, so there is nothing for npm audit to read" >&2; exit 1; }

gate="$(npm audit --omit=dev --audit-level=high 2>&1)"
gate_status=$?
printf '%s\n' "$gate"

if [ "$gate_status" -ne 0 ]; then
  if grep -q '^# npm audit report' <<<"$gate"; then
    echo "FAIL: a package that ships has a high or critical advisory (named above); update it before this can merge" >&2
  else
    echo "FAIL: npm audit gave no answer (exit $gate_status), so nothing was checked; it needs the registry (see above)" >&2
  fi
  exit 1
fi

echo
echo "All advisories, dev-only ones included. Printed to be read; only a shipped package with a high or critical advisory fails this check:"
npm audit 2>&1 || true

echo
echo "ok: no high or critical advisory in a package that ships"
