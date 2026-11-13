#!/usr/bin/env bash
# await-copilot-review.sh — request and/or wait for a GitHub Copilot PR review, robustly.
#
# WHY THIS EXISTS (two traps this script removes so no one re-hits them):
#
#   1. The Copilot reviewer's login DIFFERS by API surface:
#        GET /pulls/{n}/reviews   -> user.login = "copilot-pull-request-reviewer[bot]" (user.type "Bot")
#        GET /pulls/{n}/comments  -> user.login = "Copilot"
#        requested_reviewers      -> login "Copilot"
#      Filtering reviews by the exact login "Copilot" matches ZERO on /reviews, so a
#      naive poll waits forever while the review has already landed. This script matches
#      on user.type=="Bot" + a case-insensitive "copilot" substring instead.
#
#   2. A wrong poll predicate is indistinguishable from "the event hasn't happened yet".
#      So before waiting, this script BASELINES the matched count and, in --check mode,
#      proves the predicate fires against the reviews already on the PR. Validate the
#      detector against a known positive before trusting its silence.
#
# PORTABLE: POSIX-ish bash that runs on macOS's bash 3.2 and on Linux. Uses only `gh`
# (its built-in --jq, so no system `jq` is required), plus `awk`, `seq`, `sleep` — no
# GNU-only flags, no bash 4+ features (no associative arrays / mapfile / ${x^^}).
#
# Usage:
#   scripts/await-copilot-review.sh <pr> [--request] [--check] [--timeout-min N] [--interval-sec N]
#     --request        request a fresh Copilot review before waiting
#     --check          validate the predicate against current reviews and exit (no wait)
#     --timeout-min N  max minutes to wait      (default 30)
#     --interval-sec N poll interval in seconds (default 20)
#   GH_REPO=owner/name targets that repository instead of the checkout's default one.
#
# Exit: 0 when a new review is detected (or --check found ≥1 existing); 1 on timeout; 2 on bad args.

set -euo pipefail

PR=""
DO_REQUEST=0
CHECK_ONLY=0
TIMEOUT_MIN=30
INTERVAL_SEC=20
COPILOT_BOT="copilot-pull-request-reviewer[bot]"
# Representation-robust matcher (trap #1): a Bot whose login contains "copilot", any case
# (the "i" flag makes the whole substring case-insensitive, not just the first letter).
PRED='select(.user.type=="Bot" and (.user.login|test("copilot";"i")))'

need_value() { [ $# -ge 2 ] || { echo "$1 requires a value" >&2; exit 2; }; }
while [ $# -gt 0 ]; do
  case "$1" in
    --request) DO_REQUEST=1; shift ;;
    --check) CHECK_ONLY=1; shift ;;
    --timeout-min) need_value "$@"; TIMEOUT_MIN="$2"; shift 2 ;;
    --interval-sec) need_value "$@"; INTERVAL_SEC="$2"; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    -*) echo "unknown flag: $1" >&2; exit 2 ;;
    *) if [ -z "$PR" ]; then PR="$1"; shift; else echo "unexpected arg: $1" >&2; exit 2; fi ;;
  esac
done

[ -n "$PR" ] || { echo "usage: $0 <pr> [--request] [--check] [--timeout-min N] [--interval-sec N]" >&2; exit 2; }
command -v gh >/dev/null 2>&1 || { echo "error: gh CLI not found on PATH" >&2; exit 127; }

REPO=${GH_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}

# One line per matched review ("<id>\t<state>\t<submitted_at>"); per_page=100 avoids the
# --paginate+--jq per-page counting pitfall (review rounds never approach 100).
copilot_reviews() {
  gh api "repos/$REPO/pulls/$PR/reviews?per_page=100" \
    --jq ".[] | $PRED | \"\(.id)\t\(.state)\t\(.submitted_at)\""
}
count_lines() { awk 'NF{c++} END{print c+0}'; }

BASE=$(copilot_reviews || true)
BASE_N=$(printf '%s\n' "$BASE" | count_lines)

echo "repo=$REPO pr=$PR  existing Copilot reviews=$BASE_N"
if [ "$BASE_N" -gt 0 ]; then
  echo "predicate validated against $BASE_N existing review(s):"
  printf '%s\n' "$BASE" | sed 's/^/  /'
else
  echo "note: no existing Copilot reviews to validate the predicate against yet."
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
  [ "$BASE_N" -gt 0 ] && exit 0 || exit 1
fi

if [ "$DO_REQUEST" -eq 1 ]; then
  echo "requesting a Copilot review…"
  gh api --method POST "repos/$REPO/pulls/$PR/requested_reviewers" \
    -f "reviewers[]=$COPILOT_BOT" --jq '.requested_reviewers[].login' >/dev/null
fi

ITERS=$(( TIMEOUT_MIN * 60 / INTERVAL_SEC ))
echo "waiting for review #$(( BASE_N + 1 )) (poll ${INTERVAL_SEC}s, up to ${TIMEOUT_MIN}m)…"
i=0
while [ "$i" -lt "$ITERS" ]; do
  i=$(( i + 1 ))
  # A transient gh/network failure must not kill the wait (set -euo pipefail would otherwise exit
  # on the failed pipeline): treat a failed poll as "no change yet" and try again next interval.
  N=$(copilot_reviews 2>/dev/null | count_lines) || N="$BASE_N"
  if [ "$N" -gt "$BASE_N" ]; then
    NEW_ID=$(gh api "repos/$REPO/pulls/$PR/reviews?per_page=100" \
      --jq "map($PRED) | max_by(.submitted_at) | .id")
    STATE=$(gh api "repos/$REPO/pulls/$PR/reviews/$NEW_ID" --jq '.state')
    echo "=== Copilot review $NEW_ID landed (state=$STATE) after $(( i * INTERVAL_SEC ))s ==="
    echo "--- inline comments ---"
    gh api "repos/$REPO/pulls/$PR/comments?per_page=100" \
      --jq ".[] | select(.pull_request_review_id==$NEW_ID) | \"\(.path):\(.line // .original_line)\n  \(.body)\n\""
    exit 0
  fi
  sleep "$INTERVAL_SEC"
done

echo "TIMEOUT: no new Copilot review after ${TIMEOUT_MIN}m (count still $BASE_N)" >&2
exit 1
