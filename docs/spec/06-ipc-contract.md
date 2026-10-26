## 6. IPC contract

Use `contextIsolation: true`, `nodeIntegration: false`, and a preload script exposing a narrow, typed surface. No raw `ipcRenderer` in the renderer.

All payloads carry a `sessionId` (a single fixed id in this version). This costs nothing now and means multi-session support later is additive, not a channel redesign.

### Separate controller surface (§23.6, #217)

The controller preload exposes only `window.controller`, with the typed `ControllerApi`, and its channels, payloads and what each does, defined in `src/shared/ipc.ts`. Terminal windows retain their existing preload surfaces. The controller main process accepts subscription, activation and dismissal requests only from its own window.

`subscribeTerminals(listener)` delivers terminal snapshots and returns an unsubscribe function; `activateTerminal(id)` returns the activation outcome. Directory labels are display data, not routing authority. A confirmed activation remains completed if the connection later closes; disconnection before confirmation or expiry returns unavailable. Late responses cannot change a completed outcome or target a replacement terminal. A timeout alone does not remove a connected pane.

The main processes communicate through the bounded, versioned local protocol defined in `src/shared/controllerProtocol.ts`, not renderer IPC. Both applications share that encoder/decoder and the endpoint resolver. Terminal registration is optional and captures launch identity once; activation invokes only that terminal's window restoration/focus callback. See §23.6 for lifecycle and scope.

### Terminal surfaces

Every terminal-window channel, its payload type, and a one-sentence statement of what it does are defined in `src/shared/ipc.ts`, which assembles them from the per-domain modules in `src/shared/ipc/`. That file is the contract; this section does not repeat it.

> Captures are routed **through main** (rather than renderer-internally, which would be simpler today) so the monitor pane has no dependency on the terminal pane. When the monitor pane later becomes a separate `WebContentsView`/web app, and when captures start originating from the shadow model instead of user selection, nothing about this contract changes.

---

### Initial terminal readiness (#218)

The terminal-only `window.term.startup` API is typed in `src/shared/ipc.ts`. `ready()` invokes `startup:ready` with `sessionId`; its promise resolves only after confirmed controller registration and main-process initialization. The renderer then installs terminal/flow UI and calls `rendered()`, sending `startup:rendered` with `sessionId` to release buffered PTY output. Main validates the sender window and session on both channels. Neither channel authorizes registration or shell startup. Before readiness, the window shows waiting instructions with the §23.5 install action, whose `cli:install` handler is the one terminal channel served before readiness (v2.220); terminal input is unrouted and flow-start invokes reject. When a controller answers registration with a version mismatch (§23.6), main sends `startup:incompatible` with `sessionId`, which app to update, the terminal's protocol major version and the controller's supported range; `onIncompatible()` delivers it and the waiting screen names the app to update. Main re-sends the latest report when the window finishes loading. Closing disposes the handshake and registration.
