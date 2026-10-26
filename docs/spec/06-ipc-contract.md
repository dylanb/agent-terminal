## 6. IPC contract

**`src/shared/ipc.ts` is the contract.** Channel names, directions, and payload shapes are defined there once and imported by main, preload, and renderer; the controller's wire protocol is `src/shared/controllerProtocol.ts`. This section records only the rules those files must keep.

- **Isolation.** `contextIsolation: true`, `nodeIntegration: false`, and a preload exposing a narrow, typed surface per namespace (`window.term`, `window.monitor`, `window.flow`, …; the controller window gets only `window.controller`). No raw `ipcRenderer` in the renderer.
- **Every payload carries `sessionId`** — a single fixed id today, so multi-session support is additive, not a channel redesign. The exceptions are app-global channels with no session (UI settings, the OS clipboard, the macOS Edit menu).
- **Every payload names the resource it acts on** (a `repoKey`, a gate's `step` + `turnKey`, a dismissed event's id). The receiver never re-derives the target from ambient state, so a decision can never land on a different worktree or gate than the one the user saw.
- **Captures are routed through main**, not renderer-internally, so the monitor pane has no dependency on the terminal pane and the contract does not change when the monitor pane moves to another process or captures come from the shadow instead of a selection.
- **Controller.** The controller main process accepts subscription, activation and dismissal requests only from its own window. Directory labels are display data, not routing authority. A timeout alone does not remove a connected pane, and a late response cannot change a completed activation or target a replacement terminal (§23.6).
- **Startup readiness.** The `startup:*` channels only report and release readiness, and main validates the sender window and session on each; neither authorizes controller registration or shell start. Before readiness, `cli:install` is the one terminal channel served, so the waiting screen can install the `agent-terminal` command (§23.5); terminal input is unrouted and flow-start is refused until then.

---
