#!/usr/bin/env bash
# Dev-process aid (NOT product code; owner: dylanb). The team's own frozen-tests discipline for the S3
# RED->GREEN->refactor slices: assert no test file changed since a slice's RED commit. This mirrors, for our
# development, the §28.5.1 detect-and-escalate the product ships — the machine reports which test files moved;
# the human decides (the RED test was wrong -> redo RED; or the GREEN cheated -> reconcile).
#
# Usage: scripts/dev/slice-tests-unchanged.sh <RED-commit-SHA>
#   Run at the end of a slice's GREEN phase (before the GREEN commit) and after refactor.
#   Exit 0 + "clean" when no test changed since <RED-commit>; exit 1 + the offending paths otherwise.
# Portable bash (macOS + Linux); pure git, no wall-clock, reproducible.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <RED-commit-SHA>" >&2
  exit 2
fi
red_sha="$1"

if ! git rev-parse --verify --quiet "${red_sha}^{commit}" >/dev/null; then
  echo "not a commit: ${red_sha}" >&2
  exit 2
fi

# Our test surface: everything under tests/. Tracked changes vs the RED commit (working tree) UNION any
# untracked file added under tests/ since (a GREEN must not add or edit a test).
changed="$(git diff --name-only "${red_sha}" -- tests || true)"
untracked="$(git ls-files -o --exclude-standard -- tests || true)"

offending="$(printf '%s\n%s\n' "${changed}" "${untracked}" | sed '/^$/d' | sort -u)"

if [ -n "${offending}" ]; then
  echo "slice-tests-unchanged: VIOLATION — test files changed since ${red_sha}:" >&2
  echo "${offending}" >&2
  echo "Reconcile before committing: the RED test was wrong (redo RED) or the GREEN edited a test." >&2
  exit 1
fi

echo "slice-tests-unchanged: clean against ${red_sha}"
