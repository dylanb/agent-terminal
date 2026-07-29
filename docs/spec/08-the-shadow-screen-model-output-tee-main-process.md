## 8. The shadow screen model (output tee) — main process

This is the foundation of all agent monitoring. Every byte the PTY emits is written to **two** consumers: the renderer's xterm (what the user sees) and a main-process `@xterm/headless` terminal (what the application *knows*).

### 8.1 Why a shadow terminal, and why in main

- **Capture needs a screen model, not a byte stream.** Agent output is full of cursor movement, line rewrites (spinners, progress), and color codes. Grepping raw bytes is hopeless; reading rows out of a maintained screen grid is trivial. `@xterm/headless` is the same parser as the renderer, so the two views can never disagree about what's on screen.
- **Injection needs live mode state without the renderer.** `shadow.modes.bracketedPasteMode` tells the main-process injector exactly how to wrap text at the moment of injection (§9.3). No IPC round-trip to the renderer, no cached/stale mode.
- **Alt-screen detection is free.** `shadow.buffer.active.type === 'alternate'` distinguishes scrolling-transcript agents from full-screen TUI agents (Claude Code 2.x, Codex) — which changes both what capture means and what selection can render (§7.4). On-demand capture reads the visible alt frame either way (§21.1); the auto path stays normal-buffer-only.
- **Main-process placement** means monitoring and injection keep working regardless of renderer state, and later survive the monitor pane moving to a separate process, or the renderer being remote.

### 8.2 Implementation sketch

```js
// main process
const { Terminal: ShadowTerminal } = require('@xterm/headless');

const shadow = new ShadowTerminal({
  cols: 80, rows: 24,
  scrollback: 5000,            // match the renderer
  allowProposedApi: true,
});

let lastStatus = { altScreen: false, bracketedPaste: false, agentState: 'quiet' };
let settleTimer = null;

ptyProcess.onData((data) => {
  win.webContents.send('pty:data', { sessionId: SID, data });  // render path
  shadow.write(data);                                          // tee
  noteOutputActivity();                                        // quiescence detector (§8.3)
  clearTimeout(settleTimer);
  settleTimer = setTimeout(publishStatus, 80);                 // debounce: agents redraw in bursts
});

function publishStatus() {
  const status = {
    altScreen: shadow.buffer.active.type === 'alternate',
    bracketedPaste: shadow.modes.bracketedPasteMode,
    agentState,                                                // 'active' | 'quiet' (§8.3)
  };
  if (status.altScreen !== lastStatus.altScreen ||
      status.bracketedPaste !== lastStatus.bracketedPaste ||
      status.agentState !== lastStatus.agentState) {
    lastStatus = status;
    win.webContents.send('monitor:update', { sessionId: SID, ...status, quietSince });
  }
}

// Resize: PTY and shadow move together (pty:resize handler).
function onResize({ cols, rows }) {
  ptyProcess.resize(cols, rows);
  shadow.resize(cols, rows);
}
```

**Notes**
- `shadow.write()` is asynchronous (parsed on a queue). For *status events* the debounce above is enough. Anything that must read the buffer **after** specific bytes are parsed should use the write callback: `shadow.write(data, () => { /* buffer is current */ })`. The injector (§9.3) reads modes at injection time, after the queue has long settled, so this rarely matters in practice — but never read the buffer synchronously right after a `write()` and assume it's current.
- **Version-pin** `@xterm/headless` to the same core version as `@xterm/xterm`. Two parsers at different versions can disagree on edge-case sequences, and capture correctness depends on agreement.
- Throughput: writing every chunk twice is cheap (headless has no renderer); this is the same pattern VS Code uses for its terminal process model. Not a concern at interactive rates.
- **Reading captured text out of the shadow** (used later by semantic capture; available now for debugging): walk `shadow.buffer.active` rows via `getLine(y).translateToString(true)`, or attach `@xterm/addon-serialize` for formatted snapshots. The skeleton's capture comes from user selection in the renderer, but the shadow is the source the automated pipeline will read from — keep it accurate from day one.

### 8.3 Quiescence detection

The agent is **`active`** while its **rendered screen keeps changing** and flips to **`quiet`** once the visible buffer has been unchanged for `QUIET_MS`. Quiet is the "the agent is probably waiting for you" signal — surfaced in the monitor pane, the injection engine's "injectable" gate (§27.2), and the **trigger hook** the semantic pipeline attaches to (scan the shadow buffer on the `active → quiet` transition, not per output chunk). **Activity is a screen change, not a byte** (the shipped screen-stability refinement below): the shadow computes the visible viewport's text after each write settles and only counts a write that *changed* it as activity — so a full-screen TUI agent (Claude Code, Codex) that repaints an unchanged frame on a timer while idle correctly reads `quiet`, and a spinner/stream reads `active`.

```js
const QUIET_MS = 1000;        // no output for this long => 'quiet'; tune per agent (§14)
let agentState = 'quiet';     // 'active' | 'quiet'
let quietSince = null;        // epoch ms of the last active->quiet transition (null while active)
let quietTimer = null;

function noteOutputActivity() {
  if (agentState !== 'active') {
    agentState = 'active';
    quietSince = null;
    publishStatus();          // flip to 'working' immediately — don't wait for the settle debounce
  }
  clearTimeout(quietTimer);
  quietTimer = setTimeout(() => {
    agentState = 'quiet';
    quietSince = Date.now();
    publishStatus();          // the active->quiet transition: future semantic-scan trigger
  }, QUIET_MS);
}
```

**Semantics and design decisions**
- **Two timescales, two jobs.** The 80 ms settle debounce (§8.2) smooths redraw bursts before *reading* shadow state; the 1000 ms quiescence threshold is a *semantic* judgment that the agent has stopped talking. Keep them separate — merging them either makes status laggy or quiescence trigger-happy.
- **Quiet means "the screen stopped changing," not "waiting for input."** An agent can be thinking or waiting on the network without repainting (false quiet). A TUI that *animates* while idle (a live clock, a looping animation) still reads `active` — but a TUI that merely repaints the **same** frame does not, since an identical repaint is not a screen change. Claude Code animates a spinner *while working* (correctly `active`) and settles to a static input box when idle (correctly `quiet`) — verify per agent and treat `quiet` as a strong hint, not proof.
- **It tracks the agent, not the user.** User keystrokes don't reset the timer directly; the echo/redraw they provoke does. A session sitting at a quiet prompt stays `quiet` even as the user types — correct, since the question being answered is "has the agent stopped producing output."
- **Transitions, not levels, are the API.** Consumers (the status strip now, the semantic scanner later) subscribe to changes via `monitor:update`; nothing polls `agentState`.
- **Screen-stability quiescence (shipped).** The detector counts only output that *changed the shadow's visible buffer* as activity: `shadow.write` compares the just-parsed viewport text to the prior one and notes activity to the detector only on a difference (`quiescence.ts` is unchanged — it debounces "activity noted", the shadow decides what counts). This was the deferred refinement; it landed because byte-presence pinned a full-screen TUI agent `active` forever, which stalled the §27.2 injection gate (every turn deferred, nothing injected). The `active` flip now arrives one parse-callback tick later than byte-presence did (the buffer must be parsed to compare it) — imperceptible, and quiet is unaffected.

### 8.4 Capture events (skeleton scope)

In this version, capture events originate from the user's selection (`monitor:capture`, §6/§7.5). Main assigns `{id, capturedAt}` and rebroadcasts on `monitor:event`. The event shape is deliberately the one the future semantic pipeline will emit:

```ts
interface MonitorEvent {
  id: string;
  sessionId: string;
  type: 'capture';            // later: 'agent-question' | 'tool-use' | 'diff' | ...
  source: 'selection';        // later: 'heuristic' | 'shadow-scan' | ...
  text: string;
  range: { start: Cell; end: Cell; baseY: number;
           bufferType: 'normal'|'alternate' } | null;  // provenance only (§7.3) — never re-extract from these
  capturedAt: string;         // ISO timestamp, stamped by main
}
```

Main keeps the session's event list in memory and replays it to a (re)loaded monitor pane on request. The list is also persisted per launch-directory (`<L>/.agent-terminal/monitor-events.json`, atomic tmp+rename + owner-only `0o600`; the app never writes `.gitignore`, so ignoring `.agent-terminal/` is the user's choice, §19.1; written after each mutation) and seeded from that file on construct. The file is an **untrusted** source (a cloned repo can ship one), so on load each element is validated to the §15.4 event shape (malformed entries dropped), the file is refused above a size cap (CWE-400), the write uses an unpredictable temp name + exclusive create so a planted symlink cannot redirect it (CWE-59), and inject-able events (`command-output`, §16.2) are dropped on restore so the file cannot seed an Insert-at-cursor card (CWE-78). The `command-output` drop is **permanent, not a phase limit** — a restored file is indistinguishable from an attacker-shipped one, so even a user's own prior-session command-output never restores. Restored non-inject-able events (capture/finding/completion) remain viewable and addable to todos; their text can still reach the prompt via the manual Add-to-todo → todo Insert path, but only `submit=false` (no auto-execution) and only by deliberate multi-step user action — that manual, visible-at-prompt path is the **accepted boundary**, distinct from the one-click direct affordance the `command-output` drop removes. Events thus survive an app restart in the same directory regardless of how the prior instance terminated (v2.95), reusing this same replay path. The list is unbounded by design this phase — an accepted limit; a future eviction cap would mirror todoStore's `maxDoneTodos` (§16.4).

---

