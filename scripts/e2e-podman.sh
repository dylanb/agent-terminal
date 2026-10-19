#!/usr/bin/env bash
# Run the Electron Playwright e2e suite in a Linux container via Podman (macOS host).
# Xvfb inside the container supplies the window focus + clipboard a macOS subprocess
# launch cannot. Usage:
#   ./scripts/e2e-podman.sh                 # whole suite
#   ./scripts/e2e-podman.sh "Terminate"     # -g filter passed through to playwright
#   E2E_IO_DIR=<repo-relative dir> ./scripts/e2e-podman.sh
#                                           # red-check run (§28.5.2): the tests in <dir>/select.txt,
#                                           # JSON report to <dir>/report.json (see e2e/entrypoint.sh)
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=agent-terminal-e2e
VOLUME="${E2E_NODE_MODULES_VOLUME:-agent-terminal-e2e-node_modules}"
FILTER="${1:-}"

# Electron + Chromium + Xvfb need more than the 2 GiB default podman machine. Warn loudly
# rather than fail cryptically mid-run.
mem_mib="$(podman machine inspect --format '{{.Resources.Memory}}' 2>/dev/null || echo 0)"
if [ "${mem_mib:-0}" -lt 8192 ]; then
  echo "WARNING: podman machine has ${mem_mib} MiB RAM; Electron e2e needs >= 8 GiB." >&2
  echo "  Fix once: podman machine stop && podman machine set --memory 8192 --cpus 6 && podman machine start" >&2
fi

podman build -t "$IMAGE" -f e2e/Containerfile .

# --shm-size: Chromium crashes on the 64 MiB default /dev/shm.
# --cap-add=SYS_ADMIN + label=disable: let Chromium's sandbox run under rootless Podman.
# node_modules volume keeps the Linux build out of the macOS tree and caches it between runs.
tty=()
[ -t 0 ] && tty=(-it)
podman run --rm ${tty[@]+"${tty[@]}"} \
  --cap-add=SYS_ADMIN \
  --security-opt label=disable \
  --shm-size=1g \
  -v "$PWD":/work \
  -v "$VOLUME":/work/node_modules \
  -v agent-terminal-e2e-pnpm-store:/pnpm-store \
  -e CI=1 \
  -e E2E_GREP="$FILTER" \
  -e "E2E_IO_DIR=${E2E_IO_DIR:-}" \
  "$IMAGE"
