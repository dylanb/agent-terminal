# Agent Terminal

Foundation ("walking skeleton") of an application for running, monitoring, and steering coding agents (Claude Code, Codex, …) that live in a terminal. See `terminal-web-ui-spec.md` (v2.3) for the full design; `CLAUDE.md` for contributor standards (TDD is mandatory).

The skeleton proves the full loop: a PTY-attached shell session rendered with xterm.js, every output byte teed into a main-process `@xterm/headless` shadow screen model (mode tracking, alt-screen detection, quiescence), an app-owned focus-independent selection that can be sent back to the agent or captured into the monitor pane, and monitor-pane actions that inject text into the agent through a renderer-independent, bracketed-paste-aware path.

## Setup

This repo uses [pnpm](https://pnpm.io). `.npmrc` pins `node-linker=hoisted` so `@electron/rebuild` and electron-builder see a flat `node_modules`.

```sh
pnpm install        # postinstall runs electron-rebuild for node-pty automatically
```

> **The native-module gotcha:** `node-pty` must be compiled against **Electron's** Node ABI.
> If startup fails with a `NODE_MODULE_VERSION` mismatch (after an Electron bump, or if
> install scripts were skipped), run:
>
> ```sh
> pnpm run rebuild
> ```

## Run

```sh
pnpm run dev        # electron-vite dev mode (renderer HMR)
```

## Test

```sh
pnpm test           # vitest: unit + shadow-model integration tests
pnpm run test:e2e   # Playwright _electron: full loop against real bash (needs a display)
```

The agent-in-the-loop acceptance criteria (spec §12 — Claude Code paste-mode handling, alt-screen TUIs, quiescence tuning) are verified manually with a real agent CLI.

## Package

```sh
pnpm run package    # electron-builder: dmg/zip (macOS), AppImage/deb (Linux)
```

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `APP_SHELL` | `$SHELL`, else `bash` | Shell binary for the hosted session. Defaults to the user's login shell; set this to override (e.g. Homebrew bash on macOS). |
| `APP_SUBMIT_DELAY_MS` | `50` | Settle delay between an injected paste and the submitting `\r` (§9.3). Raise on loaded machines/CI if "Insert & submit" submissions are swallowed. |
| `APP_AUTO_GATE_DECISION_MS` | `300000` | How long the engine may take to decide an `auto` gate before it hands the gate to a human (§27.9.1 N9b.5(e)). A non-finite or non-positive value falls back to the default; fractions round up; values above 2147483647 are clamped to it. |

## Separate controller (#217, #218)

Launch **Agent Terminal Controller** and **Agent Terminal** in either order. A terminal waits with instructions until the controller confirms registration, then starts its shell automatically once. If the controller is already running but startup keeps waiting, use matching builds of both apps and restart the controller. Closing a waiting terminal cancels registration. Each pane shows the terminal’s fixed, resolved launch directory and its repository/worktree root when present. Shell navigation does not rename the pane. Two terminals in the same directory remain separate panes. Click a pane (or focus it with Tab and press Enter) to restore and focus that terminal. Activation sends no shell input, agent instructions, or gate decisions.

For development, run `pnpm run build`, then `pnpm exec electron out/main/controller.js`; launch terminals separately with `pnpm exec electron .` from the checkout, using `APP_LAUNCH_DIR` as described in Settings to select a launch directory.

Build the terminal packages with `pnpm run package`. After that build, run `pnpm exec electron-builder --config electron-builder.controller.yml` for the separate controller packages in `dist/controller`. Both use the existing macOS DMG/ZIP and Ubuntu AppImage/DEB distribution formats. Install both applications. On macOS launch `agent-terminal-controller.app`, then `agent-terminal.app`; on Ubuntu launch the controller’s desktop entry or executable, then the terminal’s. Packages contain their runtime resources and do not require a source checkout. Both apps must run as the same user with the same app-state home.

Closing the controller window minimizes it and preserves connections; restore it using the operating system’s window switcher. Use the application’s Quit action to exit. After their initial registration, terminals remain usable if the controller quits. Pending startup attempts have a two-second registration deadline and retry five seconds after failure: nominal attempt gaps are 5–7 seconds, observed bounds 5–8 seconds after rounding each measured attempt gap to the nearest millisecond, with registration within 10 seconds after a responsive controller becomes available. These bounds exclude machine suspension and event-loop starvation. After an established connection is lost, terminals retry automatically on the same bounded schedule while their original shell and agent work continue. Restarting the controller restores one pane per live terminal, including separate terminals sharing a directory. Reconnection preserves the fixed launch identity and original activation target and never restarts work or changes a human gate. Closing a terminal cancels its recovery attempts. A disconnected pane is removed automatically in C1; retained disconnected panes and explicit dismissal belong to #218. An activation that cannot be confirmed reports “Terminal unavailable” without selecting another terminal.

Linux support verification for this slice is Ubuntu only. The native desktop proof uses Ubuntu 24.04.5 LTS with Xfce 4.18/Xorg in an ARM64 VM and unpacked application directories. Native macOS GUI automation is untestable in the current environment under an explicit operator-accepted verification gap; this is not evidence of successful macOS restoration or keyboard delivery.
