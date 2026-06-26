# Running the e2e suite in a container (Podman on macOS)

The Playwright `_electron` e2e suite needs a window with real keyboard focus and an OS
clipboard. macOS will not grant either to an Electron window launched from a non-GUI
subprocess (CI shell, agent, detached process), so a large fraction of the suite fails
there with `toBeFocused()` / `clipboard.readText()` errors that look like product bugs
but are not. Running the suite inside a Linux container under **Xvfb** removes the
problem: Xvfb is a real headless X display where the window is focusable and the X
clipboard works.

## Usage

```sh
./scripts/e2e-podman.sh              # whole suite
./scripts/e2e-podman.sh "Terminate"  # filter (-g) passed to playwright
```

## One-time setup

Electron + Chromium + Xvfb need more than the 2 GiB default podman machine:

```sh
podman machine stop
podman machine set --memory 8192 --cpus 6
podman machine start
```

## How it works

- The repo source is bind-mounted; `node_modules` is a **named volume** so the
  macOS-built native modules (node-pty) never shadow the Linux ones. node-pty is rebuilt
  for the container's Electron ABI on each run.
- The container runs `xvfb-run -a pnpm exec playwright test`.
- `--shm-size=1g` avoids Chromium's `/dev/shm` crashes; `--cap-add=SYS_ADMIN` lets the
  Chromium sandbox run under rootless Podman.

## Coverage caveat

Genuinely macOS-only paths — the Dock icon, the ⌘ Edit menu, ⌘ key chords — do not
execute on Linux. They keep their unit coverage and need a real-Mac GUI run to exercise
end to end. The container validates everything else, including all focus/clipboard tests.
