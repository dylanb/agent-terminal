#!/usr/bin/env bash
# Run the Electron Playwright e2e suite in a Linux container via Podman (macOS host).
# Xvfb inside the container supplies the window focus + clipboard a macOS subprocess
# launch cannot. Usage:
#   ./scripts/e2e-podman.sh                 # whole suite
#   ./scripts/e2e-podman.sh "Terminate"     # -g filter passed through to playwright
#   E2E_IO_DIR=<repo-relative dir> ./scripts/e2e-podman.sh
#                                           # red-check run (§28.5.2): the tests in <dir>/select.txt,
#                                           # JSON report to <dir>/report.json (see e2e/entrypoint.sh)
#   E2E_REPORT_DIR=<repo-relative dir> ./scripts/e2e-podman.sh
#                                           # full run that also writes <dir>/report.json (Playwright JSON)
#                                           # and <dir>/environment.json; `pnpm run test:proof` reads both
#                                           # (docs/e2e-podman.md)
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=agent-terminal-e2e
# One node_modules volume per checkout: two checkouts' runs at once (an agent's red check in one worktree, the
# operator's e2e in another) would otherwise install into the same volume and corrupt it.
VOLUME="${E2E_NODE_MODULES_VOLUME:-agent-terminal-e2e-node_modules-$(printf %s "$PWD" | cksum | cut -d' ' -f1)}"
FILTER="${1:-}"

# Electron + Chromium + Xvfb need more than the 2 GiB default podman machine. Warn loudly
# rather than fail cryptically mid-run.
mem_mib="$(podman machine inspect --format '{{.Resources.Memory}}' 2>/dev/null || echo 0)"
if [ "${mem_mib:-0}" -lt 8192 ]; then
  echo "WARNING: podman machine has ${mem_mib} MiB RAM; Electron e2e needs >= 8 GiB." >&2
  echo "  Fix once: podman machine stop && podman machine set --memory 8192 --cpus 6 && podman machine start" >&2
fi

# Every checkout builds under the same tag, so another checkout's build can retag it at any moment. A report run
# runs, and records, the ID this build wrote, never whatever the tag names afterwards.
iidfile="$(mktemp)"
trap 'rm -f "$iidfile"' EXIT
podman build --iidfile "$iidfile" -t "$IMAGE" -f e2e/Containerfile .

run_image="$IMAGE"
report=()
if [ -n "${E2E_REPORT_DIR:-}" ]; then
  run_image="$(cat "$iidfile")"
  run_image="${run_image#sha256:}"
  report=(-e "E2E_REPORT_DIR=$E2E_REPORT_DIR" -e "E2E_IMAGE_ID=$run_image")
fi

rm -f "$iidfile"
trap - EXIT
tty=()
[ -t 0 ] && tty=(-it)
# exec + --init: a signal sent to this script reaches podman, which proxies it to the container's init; the
# entrypoint as PID 1 would ignore SIGTERM and SIGHUP, which it sets no handler for.
# --shm-size: Chromium crashes on the 64 MiB default /dev/shm.
# --cap-add=SYS_ADMIN + label=disable: let Chromium's sandbox run under rootless Podman.
# node_modules volume keeps the Linux build out of the macOS tree and caches it between runs.
exec podman run --rm --init ${tty[@]+"${tty[@]}"} \
  --cap-add=SYS_ADMIN \
  --security-opt label=disable \
  --shm-size=1g \
  -v "$PWD":/work \
  -v "$VOLUME":/work/node_modules \
  -v agent-terminal-e2e-pnpm-store:/pnpm-store \
  -e CI=1 \
  -e E2E_GREP="$FILTER" \
  -e "E2E_IO_DIR=${E2E_IO_DIR:-}" \
  ${report[@]+"${report[@]}"} \
  "$run_image"
