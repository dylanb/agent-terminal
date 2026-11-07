#!/usr/bin/env bash
# Container entrypoint for the e2e suite. Drives Xvfb manually (not xvfb-run, which hangs
# after the test process exits, masking the result). node_modules is a named volume, so
# install + rebuild run against the container's Linux/Electron ABI on each run.
set -e
# Keep pnpm's content-addressable store off the bind-mounted repo (a cached volume),
# else it lands in the host tree as a ~1 GB .pnpm-store.
pnpm install --frozen-lockfile --store-dir /pnpm-store
# electron has no install script: require('electron') downloads a missing binary, so on a fresh volume every
# Playwright worker downloaded it at once and launches failed with ETXTBSY. Fetch it once here.
node -e "require('electron')"
pnpm run rebuild
pnpm run build

Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp &
XVFB_PID=$!
export DISPLAY=:99
sleep 2

set +e
if [ -n "${E2E_IO_DIR:-}" ]; then
  # §28.5.2 — scripts/red-check.mjs writes one Playwright selector per line to select.txt and reads report.json.
  selectors=()
  while IFS= read -r line; do [ -n "$line" ] && selectors+=("$line"); done < "$E2E_IO_DIR/select.txt"
  PLAYWRIGHT_JSON_OUTPUT_NAME="$E2E_IO_DIR/report.json" pnpm exec playwright test --retries=0 --reporter=list,json "${selectors[@]}"
  code=$?
else
  # E2E_GREP optionally narrows the run (passed through from scripts/e2e-podman.sh).
  if [ -n "${E2E_REPORT_DIR:-}" ]; then
    node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({ node: process.version, electron: require("electron/package.json").version, image: process.argv[2] }))' \
      "$E2E_REPORT_DIR/environment.json" "${E2E_IMAGE_ID:-}"
    PLAYWRIGHT_JSON_OUTPUT_NAME="$E2E_REPORT_DIR/report.json" pnpm exec playwright test --forbid-only --reporter=list,json ${E2E_GREP:+-g "$E2E_GREP"}
  else
    pnpm exec playwright test --reporter=list ${E2E_GREP:+-g "$E2E_GREP"}
  fi
  code=$?
fi
kill "$XVFB_PID" 2>/dev/null
exit "$code"
