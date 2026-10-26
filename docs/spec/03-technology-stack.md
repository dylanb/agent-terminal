## 3. Technology stack

Versions are pinned in `package.json`; this table records why each choice was made.

| Concern | Choice | Rationale |
|---|---|---|
| Desktop shell | **Electron** | Renderer is a full Chromium page — the monitor pane (and any future richer agent UI) is plain web code; most prior art; uniform rendering across Linux/macOS. |
| Terminal renderer | **@xterm/xterm** + **@xterm/addon-fit** | Industry-standard web terminal (VS Code, Hyper); exposes the selection/buffer/decoration APIs we need. |
| Shadow screen model | **@xterm/headless** | Same VT parser as the renderer, running in the main process. Gives buffer access (capture), `modes` (bracketed paste), and `buffer.active.type` (alt-screen detection) with zero DOM. Pinned to the same version as the renderer so both parsers agree (§8.2). |
| PTY / shell host | **node-pty** | Cross-platform PTY bindings; the same layer VS Code uses. Runs in Electron's main process. |
| Language | TypeScript, `strict` | The IPC contract and capture-event schema benefit most. |
| Packaging | **electron-builder** | Cross-platform installers; handles native-module rebuild. |

---
