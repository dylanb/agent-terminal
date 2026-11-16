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
./scripts/e2e-podman.sh 'flowPicker\.spec\.ts|autoGate\.spec\.ts'
                                     # only those spec files: -g matches the full test title,
                                     # which includes the spec's path
E2E_IO_DIR=<repo-relative dir> ./scripts/e2e-podman.sh
                                     # red-check run (§28.5.2): runs the tests listed in
                                     # <dir>/select.txt, writes a JSON report to <dir>/report.json
E2E_REPORT_DIR=<repo-relative dir> ./scripts/e2e-podman.sh
                                     # full run with machine-readable results (see below)
```

### `E2E_REPORT_DIR` — the test-proof report contract

`pnpm run test:proof` sets `E2E_REPORT_DIR` to `.agent-terminal/test-proof`, a git-ignored
dir inside the bind-mounted checkout, and reads what the run leaves there through `src/main/testProofResults.ts`.
With it set, the run is the same full, unfiltered run, with the same live `list` output and the same retries, except
that a focused (`test.only`) test fails it, and it also writes into that dir:

- `report.json`: Playwright's JSON report of the run;
- `environment.json`: a JSON object with exactly the keys `node` (the container's `node --version`), `electron`
  (the installed `electron` package version) and `image` (the ID of the image the container ran from, which
  `scripts/e2e-podman.sh` takes from its own `podman build --iidfile` and runs by, so another checkout retagging
  `agent-terminal-e2e` mid-run cannot swap it).

The dir must already exist; the command creates it and removes both files before each run, so a run that writes
neither is never read as an earlier run's result. A missing file or key makes the proof refuse.

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
  for the container's Electron ABI on each run. Each checkout gets its own volume, named from its path, because
  two checkouts running the harness at the same time would collide installing into one; the first run in a new
  checkout installs from scratch. `E2E_NODE_MODULES_VOLUME=<name> ./scripts/e2e-podman.sh` names the volume
  instead.
- `out/` is a container-local **tmpfs**, so the app reads its build, including the example trees the build copies
  into `out/main/example/`, from the VM rather than through the macOS file share. Parallel install-examples tests
  listing them through the share intermittently failed with `ENOMEM` (`scandir`). The container's build never
  reaches the checkout's `out/`.
- The entrypoint fetches the Electron binary once (`node node_modules/electron/install.js`) before the tests.
  Electron downloads a missing binary on first `require`, so on a fresh `node_modules` volume every worker downloaded
  it at once and launches failed with `ETXTBSY`.
- The container drives Xvfb manually (`Xvfb :99 … &`, `export DISPLAY=:99`, then
  `pnpm exec playwright test`) rather than `xvfb-run`, which can hang after the test process
  exits and mask the result (see `e2e/entrypoint.sh`).
- `--shm-size=1g` avoids Chromium's `/dev/shm` crashes; `--cap-add=SYS_ADMIN` lets the
  Chromium sandbox run under rootless Podman.
- The setup check shows a setup needed button in the status bar in any directory that is not set up for agent
  loops, and every e2e launch's isolated home would trip it. So both launch paths (`tests/e2e/registeredElectron.ts` and
  `tests/e2e/controllerHarness.ts`) start the app with `APP_SETUP_CHECK=off` unless the test's own `env` sets
  `APP_SETUP_CHECK`. A test that exercises the check passes `APP_SETUP_CHECK: 'on'` in its launch `env`, as
  `tests/e2e/setupCheck.spec.ts` does through `createSetupCheckMachine()`. A case that restarts the app
  passes the same home folder and config dirs to every launch, so state the first launch wrote is still
  there after the restart.

- An agent counts as at the terminal's prompt only when its program name is in `APP_AGENT_COMMANDS` (§27.2). The
  suite's scripted agents run as `fake-agent`, so `playwright.config.ts` sets `APP_AGENT_COMMANDS` to
  `claude,codex,fake-agent` for every launch unless the environment already sets it.

## Coverage caveat

Genuinely macOS-only paths — the Dock icon, the ⌘ Edit menu, ⌘ key chords — do not
execute on Linux. They keep their unit coverage and need a real-Mac GUI run to exercise
end to end. The container validates everything else, including all focus/clipboard tests.
