# Agent Terminal

An Electron application for running, monitoring, and steering coding agents (Claude Code, Codex, …) that live in a terminal. A PTY-attached shell is rendered with xterm.js; every output byte is also teed into a main-process `@xterm/headless` shadow screen model (mode tracking, alt-screen detection, quiescence), which drives capture, a monitor pane whose actions inject text back into the agent, and task flows that run development work as chains of review loops.

See `terminal-web-ui-spec.md` for the design and `CLAUDE.md` for contributor standards (TDD is mandatory).

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
pnpm test                  # vitest: unit, integration, and browser projects
./scripts/e2e-podman.sh    # Playwright _electron e2e in a Linux container under Xvfb
```

The e2e suite needs a focusable display and an OS clipboard, which a macOS subprocess launch cannot provide; run it through the Podman harness (`docs/e2e-podman.md`).

## Package

```sh
pnpm run package    # electron-builder: dmg/zip (macOS), AppImage/deb (Linux)
```

This builds the terminal into `dist` and the separate controller (`electron-builder.controller.yml`) into `dist/controller`. `node-pty` ships as a native binary per platform, so build on (or cross-build for) each target OS.

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `APP_SHELL` | `$SHELL`, else `bash` | Shell binary for the hosted session. Set this to override the login shell (e.g. Homebrew bash on macOS). |
| `APP_LAUNCH_DIR` | `$HOME` | Directory the session starts in. An unusable directory falls back to the default. |
| `APP_SUBMIT_DELAY_MS` | `50` | Settle delay between an injected paste and the submitting `\r`. Raise on loaded machines/CI if "Insert & submit" submissions are swallowed. |
| `APP_QUIET_MS` | `1000` | How long the screen must stay unchanged before the agent reads as quiet. |
| `APP_STARTUP_EXIT_GRACE_MS` | `1000` | A shell that exits sooner than this is treated as a startup failure, and the window stays open to show the diagnostic. |
| `APP_SHELL_INTEGRATION` | on | `0` disables the bash OSC 133 hooks used for command capture. |
| `APP_AUTO_GATE_DECISION_MS` | `300000` | How long the engine may take to decide an `auto` gate before it hands the gate to a human. A non-finite or non-positive value falls back to the default; values above 2147483647 are clamped to it. |

## Separate controller

The controller is a separate app that shows one status card per launch directory. Install both apps and launch them in either order: a terminal shows a "Startup paused" card and starts its shell once, on its own, when the controller confirms registration. The card can install the `agent-terminal` command, after which `agent-terminal --controller` starts the controller from the same build. If startup keeps waiting and the card names no version mismatch, restart the controller. Both apps must run as the same user.

An ordinary single-terminal card shows the terminal's name, launch directory, status (Needs a human, Working, Idle, Completed, Disconnected or an error), ticket, flow and activity. Click a card's header (or focus it and press Enter or Space) to collapse or expand it; a collapsed card shrinks to its header. In a window narrower than 640 pixels, cards that need you start expanded and the rest start collapsed; your toggles survive membership changes and disconnection, and reset after registration from zero connections or a controller restart. **Bring forward** restores that terminal; it sends no shell input and never decides a gate — make gate decisions in the terminal. Long reasons show three lines until **Show full reason**. **Dismiss** removes a disconnected card. **Dark theme** in the window header (**Light theme** while dark is on) is the controller's own setting, separate from each terminal's theme.

The controller lives in the system tray (the menu bar on macOS). Its icon shows a dot when a card needs you: amber when a terminal needs a human, red when any card has an error (a flow error, a disconnected terminal or a duplicate directory); red wins when both apply. Click the icon to open the window. Its menu (right-click on macOS; on Linux, the menu your tray host shows) counts the connected cards, the errors and the cards needing a human, and offers **Open Controller**, **Always on top** and **Quit Controller**. Closing the window hides it on macOS (click the Dock icon or the tray icon to bring it back) and minimizes it on Linux; it keeps following your terminals while closed. To exit, use **Quit Controller** or the application menu's Quit (Cmd-Q on macOS, Ctrl+Q on Linux). Terminals keep working if the controller quits and reconnect automatically when it returns.

**Always on top** in the window header, and in the tray menu, keeps the controller above other windows; it is on for a new install. The controller remembers its size, position, always-on-top choice and theme across restarts. It reopens at the default place when the saved position is on no attached display, and never reopens maximized or full screen.

When two or more live terminals share a launch directory, their card shows **Duplicate directory**, the instance count and guidance to reduce them to one. It hides all work, ticket, human-request and error details until only one connection remains; that survivor's current ordinary information then returns. Stopping an agent without closing its terminal does not clear the conflict. Different worktrees stay separate, and changing a shell's directory does not regroup cards. The header counts cards, with a conflict counted once as an error. Collapsed conflicts retain the warning and count.

**Bring both forward** (or **Bring N terminals forward**) restores all windows represented when clicked. Failed or unconfirmed attempts produce **Terminal unavailable** feedback with the failed count out of that original total; retry uses current members. The controller never closes terminals or resolves gates: close extra instances in their actual windows. The last departure leaves one identified disconnected card with **Dismiss**; reconnect replaces it, and a delayed dismissal cannot remove a replacement.

For development: `pnpm run build`, then `pnpm exec electron out/main/controller.js`, and launch terminals with `pnpm exec electron .` (set `APP_LAUNCH_DIR` to choose each one's directory).

Native macOS GUI keyboard checks for the controller are not automated, because Accessibility/event-posting permission is unavailable to the test run; those cases are covered on Ubuntu.
