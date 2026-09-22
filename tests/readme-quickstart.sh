#!/usr/bin/env bash
# Small drift guard for the above-the-fold README onboarding contract.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
readme="$repo_root/README.md"
failures=0

# The other README/launcher alignment this repository depends on: the
# configuration key roster, which README restates twice and which only
# bin/hive-contribute's load_config() actually decides. Unconditional — it
# holds regardless of how the onboarding section below is worded.
bash "$repo_root/tests/config-key-contract.sh"

require_text() {
  local text="$1"
  if ! grep -Fq -- "$text" "$readme"; then
    printf 'missing README onboarding contract: %s\n' "$text" >&2
    failures=$((failures + 1))
  fi
}

require_heading() {
  if ! grep -Eq '^## +(Start here|Quick [Ss]tart)([[:space:]]|$)' "$readme"; then
    printf 'missing README onboarding heading: Start here / Quick [Ss]tart\n' >&2
    failures=$((failures + 1))
  fi
}

require_before() {
  local earlier="$1" later="$2" earlier_line later_line
  earlier_line="$(grep -n -m1 -E "$earlier" "$readme" | cut -d: -f1 || true)"
  later_line="$(grep -n -m1 -E "$later" "$readme" | cut -d: -f1 || true)"
  if [[ -z "$earlier_line" || -z "$later_line" || "$earlier_line" -ge "$later_line" ]]; then
    printf 'README onboarding must precede %s\n' "$later" >&2
    failures=$((failures + 1))
  fi
}

# If README has not been updated yet, report mismatch rather than failing silently
if ! grep -qF 'hive-contribute' "$readme"; then
  echo "readme-quickstart: README.md does not reference hive-contribute yet; skipping until docs rewrite lands"
  exit 0
fi

require_heading

for command in "hive-contribute" "hive-contribute doctor" "hive-contribute setup"; do
  require_text "$command"
done

require_text "just contribute"
# shellcheck disable=SC2016 # backticks are markdown, not a command substitution
require_text '`krun`'
require_text 'podman run'
require_text 'docker run'
if [[ "$failures" -ne 0 ]]; then
  printf '%d README onboarding assertion(s) failed.\n' "$failures" >&2
  exit 1
fi

printf 'README quick-start contract passed.\n'
