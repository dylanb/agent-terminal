#!/usr/bin/env bash
# Container entrypoint for the e2e suite. Drives Xvfb manually (not xvfb-run, which hangs
# after the test process exits, masking the result). node_modules is a named volume, so
# install + rebuild run against the container's Linux/Electron ABI on each run.
set -e
# Keep pnpm's content-addressable store off the bind-mounted repo (a cached volume),
# else it lands in the host tree as a ~1 GB .pnpm-store.
pnpm install --frozen-lockfile --store-dir /pnpm-store
pnpm run rebuild
pnpm run build

Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp &
XVFB_PID=$!
export DISPLAY=:99
sleep 2

set +e
# E2E_GREP optionally narrows the run (passed through from scripts/e2e-podman.sh).
pnpm exec playwright test --reporter=list ${E2E_GREP:+-g "$E2E_GREP"}
code=$?
kill "$XVFB_PID" 2>/dev/null
exit "$code"
