# Agent Terminal

Foundation ("walking skeleton") of an application for running, monitoring, and steering coding agents (Claude Code, Codex, …) that live in a terminal. See `terminal-web-ui-spec.md` (v2.3) for the full design; `CLAUDE.md` for contributor standards (TDD is mandatory).

The skeleton proves the full loop: a PTY-attached bash session rendered with xterm.js, every output byte teed into a main-process `@xterm/headless` shadow screen model (mode tracking, alt-screen detection, quiescence), an app-owned focus-independent selection that can be sent back to the agent or captured into the monitor pane, and monitor-pane actions that inject text into the agent through a renderer-independent, bracketed-paste-aware path.

## Setup

```sh
npm install        # postinstall runs electron-rebuild for node-pty automatically
```

> **The native-module gotcha:** `node-pty` must be compiled against **Electron's** Node ABI.
> If startup fails with a `NODE_MODULE_VERSION` mismatch (after an Electron bump, or if
> install scripts were skipped), run:
>
> ```sh
> npm run rebuild
> ```

## Run

```sh
npm run dev        # electron-vite dev mode (renderer HMR)
```

## Test

```sh
npm test           # vitest: unit + shadow-model integration tests
npm run test:e2e   # Playwright _electron: full loop against real bash (needs a display)
```

The agent-in-the-loop acceptance criteria (spec §12 — Claude Code paste-mode handling, alt-screen TUIs, quiescence tuning) are verified manually with a real agent CLI.

## Package

```sh
npm run package    # electron-builder: dmg/zip (macOS), AppImage/deb (Linux)
```

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `APP_SHELL` | `bash` | Shell binary for the hosted session (e.g. Homebrew bash on macOS). |
| `APP_SUBMIT_DELAY_MS` | `50` | Settle delay between an injected paste and the submitting `\r` (§9.3). Raise on loaded machines/CI if "Insert & submit" submissions are swallowed. |
