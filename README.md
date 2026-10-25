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

## Separate controller (#217–#219)

Launch **Agent Terminal Controller** and **Agent Terminal** in either order. A terminal waits with instructions until the controller confirms registration, then starts its shell automatically once. Compatible WebSocket builds update independently. When protocol versions are incompatible, the waiting screen names the app to update. If startup keeps waiting without that message, restart the controller; when moving from an older newline-protocol build, update both apps. Closing a waiting terminal cancels registration. Each pane shows the terminal’s fixed, resolved launch directory and its repository/worktree root when present. Shell navigation does not rename the pane. Two terminals in the same directory remain separate panes. Click a pane (or focus it with Tab and press Enter) to restore and focus that terminal. Activation sends no shell input, agent instructions, or gate decisions.

Live panes also show the current flow and step, issue number and shortened issue title, terminal activity, errors, and human-needed status with the available reasons. A title preview uses ellipsis; the issue number stays visible. Reasons wrap in full for snapshots up to 1 MiB of serialized UTF-8. Larger snapshots show an explicit unavailable message directing you to open the terminal for the full reason; normal status returns automatically when it fits. “Unassigned” means no flow run has started; it does not mean the terminal is idle. Ticketless work, completed runs, and active/idle terminal activity are shown separately. Unknown flow or ticket information and loading/unavailable titles are labeled explicitly. Status follows the terminal's current work even when shell navigation changes its repository; the pane's launch identity and activation target stay fixed.

Available source changes appear within two seconds without refreshing or keeping the terminal visible. Title retrieval may take longer; its result appears within two seconds of becoming available. Human-needed status and current gate/failure reasons remain until the terminal leaves that state: opening its pane does not acknowledge or resolve a gate. Make gate decisions in the terminal. Disconnected panes remove work details so the last activity cannot look live. Existing OS notifications remain unchanged.

For development, run `pnpm run build`, then `pnpm exec electron out/main/controller.js`; launch terminals separately with `pnpm exec electron .` from the checkout, using `APP_LAUNCH_DIR` as described in Settings to select a launch directory.

`pnpm run package` builds both the terminal packages in `dist` and the separate controller packages in `dist/controller`. Both use the existing macOS DMG/ZIP and Ubuntu AppImage/DEB distribution formats. Install both applications. On macOS launch `agent-terminal-controller.app`, then `agent-terminal.app`; on Ubuntu launch the controller’s desktop entry or executable, then the terminal’s. Packages contain their runtime resources and do not require a source checkout. Both apps must run as the same user with the same app-state home.

The controller and terminals communicate using WebSockets over a private local Unix socket. Protocol 2.0 includes live status. Within a supported major version, minor versions are additive and unknown fields are ignored; incompatible majors produce update guidance and keep startup waiting. The previous newline wire format is retired, so upgrading from it requires updating both apps once. Future compatible WebSocket builds do not require coordinated updates. Slow status transfers have no message-completion deadline, while size and buffering limits remain enforced.

Closing the controller window minimizes it and preserves connections; restore it using the operating system’s window switcher. Use the application’s Quit action to exit. After their initial registration, terminals remain usable if the controller quits. Pending startup attempts have a two-second registration deadline and retry five seconds after failure: nominal attempt gaps are 5–7 seconds, observed bounds 5–8 seconds after rounding each measured attempt gap to the nearest millisecond, with registration within 10 seconds after a responsive controller becomes available. These bounds exclude machine suspension and event-loop starvation. After an established connection is lost, terminals retry automatically on the same bounded schedule while their original shell and agent work continue. Restarting the controller restores one pane per live terminal, including separate terminals sharing a directory. Reconnection preserves the fixed launch identity and original activation target and never restarts work or changes a human gate. Closing a terminal cancels its recovery attempts. Normal terminal exit or connection loss leaves its directory and repository visible as a disconnected error while the controller keeps running. Disconnected entries cannot activate a terminal; other live panes remain usable. Use Dismiss on a disconnected pane to remove it. If none remain, the controller explains how to connect a terminal. Reconnecting or launching a terminal from the same fixed launch directory replaces disconnected entries for that directory; other directories and live same-directory peers are preserved. Dismissal never stops terminal work or prevents later connections. An activation that cannot be confirmed reports “Terminal unavailable” without selecting another terminal.

Linux support verification for this slice is Ubuntu only. The native desktop proof uses Ubuntu 24.04.5 LTS with Xfce 4.18/Xorg in an ARM64 VM and unpacked application directories. Native macOS lifecycle tests have passed for startup, outage recovery, retained errors, dismissal/replacement and human gates. The direct, replayed-registration and automatic-reconnection desktop-keyboard cases, surviving-terminal desktop activation, and packaged desktop-keyboard checks are excluded on macOS under the operator-approved per-test exception because Accessibility/event-posting permission is unavailable. These exclusions are not passes or evidence of macOS restoration and desktop keyboard delivery; the corresponding checks pass on native Ubuntu.

Controller work status recovers from a fresh snapshot after an outage. Disconnection removes work details and obsolete attention announcements; dismissal and reconnection cannot replay old gate or error reasons. Work continues in the original terminal during recovery.
