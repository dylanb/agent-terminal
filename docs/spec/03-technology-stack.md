## 3. Technology stack

| Concern | Choice | Rationale |
|---|---|---|
| Desktop shell | **Electron** | Renderer is a full Chromium page — the monitor pane (and any future richer agent UI) is plain web code; most prior art; uniform rendering across Linux/macOS. |
| Terminal renderer | **@xterm/xterm** + **@xterm/addon-fit** | Industry-standard web terminal (VS Code, Hyper); exposes the selection/buffer/decoration APIs we need. |
| Shadow screen model | **@xterm/headless** | Same VT parser as the renderer, running in the main process. Gives buffer access (capture), `modes` (bracketed paste), and `buffer.active.type` (alt-screen detection) with zero DOM. **Pin to the same xterm core version as the renderer** so both parsers agree. |
| PTY / shell host | **node-pty** | Cross-platform PTY bindings (Linux/macOS/Windows); the same layer VS Code uses. Runs in Electron's main process. |
| Language | TypeScript (recommended) or JavaScript | TS recommended — the IPC contract and capture-event schema benefit most. |
| Packaging | **electron-builder** | Cross-platform installers; handles native-module rebuild. |

> **Alternative:** The architecture maps onto **Tauri 2 + portable-pty** (Rust backend) if a smaller binary is preferred later — but note the shadow screen model would then need a Rust-side VT parser (e.g. `vt100`/`wezterm-term`) instead of `@xterm/headless`. The frontend (xterm.js, selection, monitor pane) is identical. This spec assumes Electron.

---

