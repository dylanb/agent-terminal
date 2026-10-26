## 6. IPC contract

Use `contextIsolation: true`, `nodeIntegration: false`, and a preload script exposing a narrow, typed surface. No raw `ipcRenderer` in the renderer.

All payloads carry a `sessionId` (a single fixed id in this version). This costs nothing now and means multi-session support later is additive, not a channel redesign.

### Separate controller surface (§23.6, #217)

The controller preload exposes only `window.controller`, with the typed `ControllerApi` and channel names defined in `src/shared/ipc.ts`. Terminal windows retain their existing preload surfaces. The controller main process accepts subscription, activation and dismissal requests only from its own window.

| Channel | Direction | Payload | Meaning |
|---|---|---|---|
| `controller:dismiss` | renderer → main | `{sessionId, id}` | Remove only the targeted disconnected occurrence. Unknown, live and replaced identities are harmless no-ops; never stop terminal work or prevent registration. |
| `controller:subscribe` | renderer → main | `{sessionId}` | Request the current live and retained-disconnected terminal snapshot. |
| `controller:terminals` | main → renderer | `{sessionId, terminals: ControllerTerminal[]}` | Live and retained-disconnected identities, also pushed when registrations change. Each terminal carries an opaque `id`, fixed `launchDirectory`, nullable `repositoryRoot`, and optional `status` (`connected` or `disconnected`; absent means connected). Disconnected identities have no live activation route. |
| `controller:activate` | renderer → main (invoke) | `{sessionId, id} → 'activated' \| 'unavailable'` | Activate only the live connection named by `id`; no shell input or flow operation is accepted. |

`subscribeTerminals(listener)` delivers terminal snapshots and returns an unsubscribe function; `activateTerminal(id)` returns the activation outcome. Directory labels are display data, not routing authority. A confirmed activation remains completed if the connection later closes; disconnection before confirmation or expiry returns unavailable. Late responses cannot change a completed outcome or target a replacement terminal. A timeout alone does not remove a connected pane.

The main processes communicate through the bounded, versioned local protocol defined in `src/shared/controllerProtocol.ts`, not renderer IPC. Both applications share that encoder/decoder and the endpoint resolver. Terminal registration is optional and captures launch identity once; activation invokes only that terminal's window restoration/focus callback. See §23.6 for lifecycle and scope.

### Terminal surfaces

| Channel | Direction | Payload | Meaning |
|---|---|---|---|
| `pty:data` | main → renderer | `{sessionId, data: string}` | Output bytes to write to xterm. |
| `pty:input` | renderer → main | `{sessionId, data: string}` | Keystrokes or pasted text to write to the PTY. |
| `pty:resize` | renderer → main | `{sessionId, cols, rows}` | Resize the PTY **and** the shadow terminal. |
| `pty:exit` | main → renderer | `{sessionId, code: number}` | Shell exited; main then terminates the app (§5). The renderer's reaction is transient. |
| `monitor:capture` | renderer → main | `{sessionId, text, range, source: 'selection'}` | User captured a region; main stamps `{id, capturedAt}` and broadcasts it back on `monitor:event`. |
| `monitor:event` | main → renderer | `{sessionId, event}` | Manual captures, semantic events, and command-output blocks. `event = {id, type, source, text, range, parentId, truncated, capturedAt}`; `type`/`source` are the §15.4 unions, `parentId` links a finding to its report (§15.4 / v2.6). **Amended v2.27 (§21/D39):** reports/findings no longer arrive on this push channel — they are pulled on demand via `capture:last`. The channel remains for any non-report event use. |
| `monitor:eventRemoved` | main → renderer | `{sessionId, eventId}` | The scanner retracted a prior semantic event because a later capture supersedes it (its text is an exact prefix of the newer one — §15.3 / v2.13); the pane drops the block, cascading to a report's findings. **Retired v2.27 (§21/D39):** single-slot capture replaces in place, so cross-transition retraction is no longer used. |
| `monitor:update` | main → renderer | `{sessionId, altScreen: boolean, bracketedPaste: boolean, agentState: 'active'\|'quiet', quietSince: number\|null}` | Debounced shadow-state and activity changes (live status indicators). **Status-only** — it carries no command data. |
| `monitor:replay` | renderer → main (invoke) | `() → MonitorEvent[]` | A (re)loaded monitor pane requests the captures stamped so far (§8.4). |
| `monitor:currentRepo` | renderer → main (invoke) | `{sessionId} → {cwd, repoKey} \| null` | The agent's current repo, queried on mount so the pane learns the key even when it missed the live `cwd:changed` broadcast (§16.3, v2.19). |
| `monitor:dismiss` | renderer → main | `{sessionId, eventId}` | Remove a captured event from the store; dismissing a report cascades to its findings, so a reloaded pane's replay won't resurrect it (§15.6 / v2.6). |
| `monitor:dismissAll` | renderer → main | `{sessionId}` | Clear every captured event from the store (Dismiss-all; §15.6 / v2.6). **Retired v2.27 (§21/D39):** no capture list to clear under single-slot capture. |
| `monitor:learnChrome` | renderer → main | `{sessionId, eventId, sample}` | **Mark as chrome** (§15.x / v2.14): learn the block's leading glyphs as chrome markers (persisted), then retract the capture via `monitor:eventRemoved` (cascading to findings). |
| `agent:inject` | renderer → main | `{sessionId, text, submit: boolean}` | Action-window action: paste-wrap per live mode, write to PTY, optionally submit. Focus follows the §16.2 rule (renderer-side): Insert → terminal, Insert & submit → stays. |
| `todo:list` | renderer → main (invoke) | `{sessionId, repoKey} → TodoItem[]` | Current repo's todos (active + done), order-sorted (§16.3). |
| `todo:add` | renderer → main (invoke) | `{sessionId, repoKey, text, source?} → TodoItem[]` | Append a todo (manual or Add-to-todo); returns the fresh list (§16.4). |
| `todo:update` | renderer → main (invoke) | `{sessionId, repoKey, id, text} → TodoItem[]` | Save an in-place edit (§16.4). |
| `todo:reorder` | renderer → main (invoke) | `{sessionId, repoKey, orderedIds} → TodoItem[]` | Persist a new active-list order (drag / up-down; §16.4). |
| `todo:setStatus` | renderer → main (invoke) | `{sessionId, repoKey, id, status} → TodoItem[]` | Set the tri-state status `active`/`in_progress`/`done` (§16.3): checkbox flips not-done→done or done→active; Send marks `in_progress`. |
| `todo:delete` | renderer → main (invoke) | `{sessionId, repoKey, id} → TodoItem[]` | Remove a todo (§16.4). |
| `cwd:changed` | main → renderer | `{sessionId, repoKey, cwd}` | The agent's repo key changed (OSC 7 → §16.3); the pane re-pulls `todo:list`, blocking a swap mid-edit (§16.3). |
| `ui:getSettings` | renderer → main (invoke) | `() → UiSettings` | Global UI prefs — `{splitRatio, lastTab, theme, artifactTreeWidth, artifactFullscreenTreeWidth?, keymapProfile, keymapOverrides?}` (§16.6 / §7.7). |
| `ui:setSettings` | renderer → main | `{settings: Partial<UiSettings>}` | Persist global UI prefs to userData (§16.6). |
| `term:clipboardWrite` | renderer → main | `{text}` | Write to the OS clipboard (§7.7) — owned by main since the sandboxed preload cannot import electron's `clipboard`. App-global, **no `sessionId`** (the §16.6 `UiSettings` exception). |
| `term:clipboardRead` | renderer → main (invoke) | `() → string` | Read the OS clipboard for the sanitized paste path (§7.7/§9.3). App-global, no `sessionId`. |
| `menu:edit` | main → renderer | `{action}` (`action ∈ copy \| paste \| selectAll`) | macOS Edit-menu accelerators route here (§7.7); the renderer dispatches to the terminal clipboard action or the focused input's native editing. App-global, no `sessionId`. |
| `capture:last` | renderer → main (invoke) | `{sessionId} → MonitorEvent[]` | **(v2.27, §21/D39; shape v2.34)** Run report-detection (§15.3) **on demand** against the current shadow buffer and return the single latest report **followed by its findings** as stored `MonitorEvent`s — `[]` when none. Mirrors `monitor:replay`'s shape so the pane renders a button-capture and a replay identically; the handler replaces any prior `report` in the store first (single-slot). Skips a candidate that is just the echoed command line, or one an active classifier flags as its agent's end-of-turn meta-summary (Claude Code's `※ recap:` line — a meta-summary, not a report; v2.96, §15.3). |
| `flow:list` | renderer → main (invoke) | `{sessionId} → FlowDef[]` | **(v2.27, §18)** The merged flow-definition library (global ∪ per-repo, repo wins on name clash — §18.4). Its selectable view is served per worktree by `flow:listCatalog` (v2.166). |
| `flow:setActiveFlow` | renderer → main (invoke) | `{sessionId, repoKey, id} → {ok: true} \| {ok: false, reason}` | **(v2.168, §18.7.2/§18.7.4; #133/#134)** Write the picker's catalog `id` as the **named worktree's** active-flow pointer (never ambient), only while its run has never started. Refused with a human-readable reason when the run has begun, when begun-ness is indeterminate (fail-closed), while a live or unidentifiable peer holds the worktree lock (§18.7.4, v2.162; the reason names the lockfile to delete when the holder cannot be identified), or when the write faults; a refused write leaves the prior on-disk selection byte-for-byte unchanged. A `repoKey` the app never entered is refused. |
| `flow:clearActiveFlow` | renderer → main (invoke) | `{sessionId, repoKey} → {ok: true} \| {ok: false, reason}` | **(v2.168, §18.7.2/§18.7.4; #133/#134)** Return the named worktree's active-flow pointer to unset ("use the default"), gated and refused exactly as `flow:setActiveFlow`. |
| `flow:listCatalog` | renderer → main (invoke) | `{sessionId, repoKey} → {ok: true, listing: FlowCatalogListing} \| {ok: false, reason}` | **(v2.166, §18.7.6; #134)** The picker's listing of the catalog **for the named worktree** (never ambient): each entry with its tier and availability (an unavailable entry carries a display-safe reason), per-tier notices, the worktree's active-flow selection (`unset` / `value` / `invalid`), and — only for a held run (§18.7.3) — every recovery choice in the order the picker lists it, each naming whether it resumes the run, ends it, or is unavailable with a display-safe reason (v2.167). A `repoKey` the app never entered is refused with a reason. |
| `flow:rebindHeldRun` | renderer → main (invoke) | `{sessionId, repoKey, choice, ifStepMissing} → {ok: true, outcome: 'resumed'} \| {ok: true, outcome: 'terminated', notice?} \| {ok: false, reason}` | **(v2.166, §18.7.3/§18.7.4; #134)** Re-bind the named worktree's **held** run (begun, run record missing or unreadable) to `choice` (`{origin: 'local'}`, `{origin: 'repo' \| 'global', id}` or `{origin: 'fallback'}`) under the worktree lock. A chosen flow containing the held step resumes there; one lacking it ends the run as a Terminate does only when `ifStepMissing` is `{endRunHeldAt}` — sent after the operator confirms, naming the held step (as the flow view shows it) the confirmation was given for — and is refused on `'refuse'` or when the run is now held at another step (v2.167). A never-started, intact-record or indeterminate worktree, a worktree whose lock a live or unidentifiable peer holds (v2.162), a worktree with a loop turn in flight (v2.168), or a `repoKey` the app never entered, is refused and nothing is written. |
| `flow:start` | renderer → main (invoke) | `{sessionId, flowName, inputs} → FlowState` | **(v2.27, §19)** Instantiate the chosen definition, begin step 1, run its entry actions (incl. `bootstrap: pickup` if declared — §18.3). |
| `flow:state` | renderer → main (invoke) | `{sessionId, repoKey} → FlowStateView` | **(v2.27, §19; repoKey/view v2.52)** Current step, per-step status, gate state, derived loop progress, refs, loop activity, and optional `userTitle` (§19.1 / §22.3.1). The raw durable started-ness `runStarted` (§18.7.4) and, for a begun run, `runHold` (§18.7.3, v2.166): `{hold: 'not-held'}` or `{hold: 'record-missing' \| 'record-unreadable', step, status}`, whose `step` is the display-safe copy of the held step — the value `flow:rebindHeldRun`'s `endRunHeldAt` must echo exactly, and which may be empty (v2.168). |
| `flow:setTitle` | renderer → main (invoke) | `{sessionId, repoKey, title} → FlowStateView` | **(v2.133, §22.3.1)** Name the registered worktree's work. `title` is bounded by `TITLE_MAX`; blank clears it. The response is the newly persisted view, while a refused or unsafe write rejects for visible rollback/error handling. |
| `flow:advance` | renderer → main (invoke) | `{sessionId, repoKey, step?} → FlowStateView` | **(v2.27, §19.2; `step?` v2.185)** User-driven advance of the named worktree's flow to the next step. Warns (does not block) if the current gate is unsatisfied (`ready: false` in the result). `step`, when sent, is the step the strip showed (§27.9.1 N9b.5(e)): a request naming a step the flow has left advances nothing and returns the view with a notice. Without `step` the current step is advanced, as before v2.185. |
| `flow:undo` | renderer → main (invoke) | `{sessionId, repoKey} → FlowStateView` | **(v2.64, §24.2.2)** Revert a manual advance: `done → in_progress` **without** re-running the step's entry actions (distinct from `flow:restart`). `window.flow.undo(repoKey)`. |
| `flow:appGateDecision` | renderer → main | `{sessionId, repoKey, step, turnKey, option}` | **(§27.9/§27.13, N5)** The human's one-way decision at a §27 (app-namespace) gate. Carries the `step`+`turnKey` identity it acts on (§6) so a decision can never fire against another gate; `option` is typed on the shared `GATE_DECISION_OPTIONS` set, and the guard that a step never runs an option its bound def does not declare is enforced at the operation (AC9). The result surfaces through the §27 run state → `flow:onStateChanged` re-pull. |
| `flow:composeFeedback` | renderer → main (invoke) | `{sessionId, todoIds, instructions?, mode: 'compose'\|'verbatim'} → string` | **(v2.27, §19.4)** Build request-changes feedback from selected review todos (+ optional instructions): agent-composed or submitted verbatim (D9/D11). |
| `flow:openChild` | renderer → main (invoke) | `{sessionId, prRef} → {worktree, launched}` | **(v2.27, §23; shape v2.169)** Create a git worktree for an epic child PR and launch a new instance (D22); its flow is bound at Start (§23.2, §18.7.5, D63). |
| `flow:onStateChanged` | main → renderer | `{sessionId}` | **(v2.27, §19; built v2.63, §24.2.2 S5)** A flow-relevant input changed — a count-changing todo mutation or the §8.3 `active↔quiet` flip; the strip re-pulls `flow:state` (whose `in_progress` view carries the derived `n/m done` + activity + readiness). `window.flow.onStateChanged(cb)` returns an unsubscribe. (Agent-loop file-watch is still future.) |
| `viewer:tree` | renderer → main (invoke) | `{sessionId, scope: 'curated'\|'repo'} → ArtifactTree` | **(v2.27/§20.1; built v2.37)** Hierarchical, provenance-tagged tree off the session cwd: curated (the superset of working-tree changes ∪ files committed on the branch over its PR base ∪ `.agent-loop/`) or whole repo, tagged `changed`/`loop`/`pr` (§20.1); `ArtifactTree` wraps `nodes` + `root` + `isRepo` + `scope`, so outside a repo it returns the cwd tree with `isRepo:false`. |
| `viewer:read` | renderer → main (invoke) | `{sessionId, relPath} → ViewerFile \| null` | **(v2.27/§20.2; built v2.37)** File content for the viewer (markdown / code), classified by extension; null on missing/binary/oversized/path-escape. **(v2.41; v2.98)** `ViewerFile.changedLines` carries the code file's lines that differ from the PR base (the merge-base, else `HEAD`; §20.2) — added/modified, 1-based; absent when none. |
| `viewer:onChanged` | main → renderer | `{sessionId}` | **(v2.83, §20.1)** A file under the viewer's tree root changed on disk; the viewer re-pulls `viewer:tree`/`viewer:read`. Payload-free beyond the session (the viewer re-discovers against its own live cwd), mirroring `flow:onStateChanged`. One recursive watcher, re-rooted on each `cwd:changed`, coalesced over `VIEWER_WATCH_DEBOUNCE_MS` and filtered against `IGNORED_DIRS` so a refresh's own git write can't loop. |
| `viewer:ghRefresh` | renderer → main (invoke) | `{sessionId, ref} → {path}` | **(v2.27, §20.3)** Refresh a ticket/PR markdown via the `gh` CLI from main and update the cached artifact (D24). |
| `todoTemplate:list` | renderer → main (invoke) | `{sessionId, repoKey} → TodoTemplateList` | **(v2.27, §21.2; repoKey v2.58; v2.59)** Templates co-located with the repo's flow.yaml (§18.6) **gated to an in_progress step**, plus the bound `defaultRef`; `name` is the H1/humanized label. On `window.monitor` (§9.1), surfaced by the todo-overlay picker (§4.1). |
| `todoTemplate:instantiate` | renderer → main (invoke) | `{sessionId, repoKey, ref} → TodoItem[]` | **(v2.27, §21.2)** Parse a markdown-list template (named or file path — D37/D38) into todos and append them. |
| `cli:install` | renderer → main (invoke) | `{sessionId} → CliInstallResult` | **(v2.89, §23.4 / #25)** Install the `agent-terminal` launch shim onto PATH for the running build. Served from window creation, before controller registration, so the waiting screen can install it (v2.220). No path payload (the install target derives from the process's launch facts); `CliInstallResult = {ok, path?, error?}` — `ok` only when runnable from a new shell, else a visible `error` (no partial-success state). |
| `examples:preview` | renderer → main (invoke) | `{sessionId} → InstallExamplesPreview` | **(v2.134, §18.1 / #41)** Report, **per destination**, the bundled files that already exist and differ. Writes nothing. A destination's preview is a discriminated union: no conflict carries no files and asks for no decision. |
| `examples:apply` | renderer → main (invoke) | `{sessionId, previewId, replace: InstallDestinationId[]} → InstallExamplesResult` | **(v2.134, §18.1 / #41)** Seed every destination. `replace` names the destinations the user consented to replace conflicting files in — one decision per destination, so consenting in one never replaces files in another; absent files are created regardless. The result groups `created`/`overwritten`/`skipped` **by destination**, so two destinations sharing a file name yield two attributable entries. A failure carries `created`/`overwritten` too (see §18.1). `previewId` names the one preview this apply acts on; `notInstalled` names each destination skipped because its root does not exist, with that root (v2.199). |

> Captures are routed **through main** (rather than renderer-internally, which would be simpler today) so the monitor pane has no dependency on the terminal pane. When the monitor pane later becomes a separate `WebContentsView`/web app, and when captures start originating from the shadow model instead of user selection, nothing about this contract changes.

**preload.js**
```js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('term', {
  onData:   (cb) => ipcRenderer.on('pty:data', (_e, m) => cb(m.data)),
  onExit:   (cb) => ipcRenderer.on('pty:exit', (_e, m) => cb(m)),
  input:    (data) => ipcRenderer.send('pty:input',  { sessionId: SID, data }),
  resize:   (size) => ipcRenderer.send('pty:resize', { sessionId: SID, ...size }),
});

contextBridge.exposeInMainWorld('monitor', {
  capture:  (block) => ipcRenderer.send('monitor:capture', { sessionId: SID, ...block }),
  onEvent:  (cb) => ipcRenderer.on('monitor:event',  (_e, m) => cb(m.event)),
  onUpdate: (cb) => ipcRenderer.on('monitor:update', (_e, m) => cb(m)),
  onExit:   (cb) => ipcRenderer.on('pty:exit',       (_e, m) => cb(m)), // session alive/exited (§9.2)
  replay:   () => ipcRenderer.invoke('monitor:replay'),
  inject:   (req) => ipcRenderer.send('agent:inject', { sessionId: SID, ...req }),
  // Todo (§16) — repoKey threaded so an in-flight edit always targets its own repo
  todoList:   (repoKey) => ipcRenderer.invoke('todo:list',   { sessionId: SID, repoKey }),
  todoAdd:    (repoKey, text, source) => ipcRenderer.invoke('todo:add', { sessionId: SID, repoKey, text, source }),
  todoUpdate: (repoKey, id, text) => ipcRenderer.invoke('todo:update', { sessionId: SID, repoKey, id, text }),
  todoReorder:(repoKey, orderedIds) => ipcRenderer.invoke('todo:reorder', { sessionId: SID, repoKey, orderedIds }),
  todoSetStatus:(repoKey, id, status) => ipcRenderer.invoke('todo:setStatus', { sessionId: SID, repoKey, id, status }),
  todoDelete: (repoKey, id) => ipcRenderer.invoke('todo:delete', { sessionId: SID, repoKey, id }),
  onCwdChanged: (cb) => ipcRenderer.on('cwd:changed', (_e, m) => cb(m)),
  getSettings: () => ipcRenderer.invoke('ui:getSettings'),
  setSettings: (settings) => ipcRenderer.send('ui:setSettings', { settings }),
  captureLast: () => ipcRenderer.invoke('capture:last', { sessionId: SID }), // v2.27, §21
});

// v2.27 (§17–§24): task-flow management exposes two further namespaces, same narrow/typed pattern.
contextBridge.exposeInMainWorld('flow', {
  list:    () => ipcRenderer.invoke('flow:list', { sessionId: SID }),
  start:   (flowName, inputs) => ipcRenderer.invoke('flow:start', { sessionId: SID, flowName, inputs }),
  state:   () => ipcRenderer.invoke('flow:state', { sessionId: SID }),
  advance: (repoKey, step) => ipcRenderer.invoke('flow:advance', { sessionId: SID, repoKey, step }), // step optional, v2.185
  appGateDecision: (repoKey, step, turnKey, option) => ipcRenderer.send('flow:appGateDecision', { sessionId: SID, repoKey, step, turnKey, option }),
  composeFeedback: (todoIds, instructions, mode) => ipcRenderer.invoke('flow:composeFeedback', { sessionId: SID, todoIds, instructions, mode }),
  openChild: (prRef) => ipcRenderer.invoke('flow:openChild', { sessionId: SID, prRef }),
  onStateChanged: (cb) => ipcRenderer.on('flow:onStateChanged', (_e, m) => cb(m)),
  templateList: () => ipcRenderer.invoke('todoTemplate:list', { sessionId: SID }),
  templateInstantiate: (repoKey, ref) => ipcRenderer.invoke('todoTemplate:instantiate', { sessionId: SID, repoKey, ref }),
});
contextBridge.exposeInMainWorld('viewer', {
  tree: (scope) => ipcRenderer.invoke('viewer:tree', { sessionId: SID, scope }),
  read: (relPath) => ipcRenderer.invoke('viewer:read', { sessionId: SID, relPath }),
  ghRefresh: (ref) => ipcRenderer.invoke('viewer:ghRefresh', { sessionId: SID, ref }),
});
```

---


### Initial terminal readiness (#218)

The terminal-only `window.term.startup` API is typed in `src/shared/ipc.ts`. `ready()` invokes `startup:ready` with `sessionId`; its promise resolves only after confirmed controller registration and main-process initialization. The renderer then installs terminal/flow UI and calls `rendered()`, sending `startup:rendered` with `sessionId` to release buffered PTY output. Main validates the sender window and session on both channels. Neither channel authorizes registration or shell startup. Before readiness, the window shows waiting instructions with the §23.5 install action, whose `cli:install` handler is the one terminal channel served before readiness (v2.220); terminal input is unrouted and flow-start invokes reject. When a controller answers registration with a version mismatch (§23.6), main sends `startup:incompatible` with `sessionId`, which app to update, the terminal's protocol major version and the controller's supported range; `onIncompatible()` delivers it and the waiting screen names the app to update. Main re-sends the latest report when the window finishes loading. Closing disposes the handshake and registration.
