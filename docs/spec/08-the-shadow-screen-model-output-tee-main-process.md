## 8. The shadow screen model (output tee) — main process

This is the foundation of all agent monitoring. Every byte the PTY emits is written to **two** consumers: the renderer's xterm (what the user sees) and a main-process `@xterm/headless` terminal (what the application *knows*).

### 8.1 Why a shadow terminal, and why in main

- **Capture needs a screen model, not a byte stream.** Agent output is full of cursor movement, line rewrites (spinners, progress), and color codes. Grepping raw bytes is hopeless; reading rows out of a maintained screen grid is trivial. `@xterm/headless` is the same parser as the renderer, so the two views can never disagree about what's on screen.
- **Injection needs live mode state without the renderer.** `shadow.modes.bracketedPasteMode` tells the main-process injector exactly how to wrap text at the moment of injection (§9.3). No IPC round-trip to the renderer, no cached/stale mode.
- **Alt-screen detection is free.** `shadow.buffer.active.type === 'alternate'` distinguishes scrolling-transcript agents from full-screen TUI agents (Claude Code 2.x, Codex) — which changes both what capture means and what selection can render (§7.4). On-demand capture reads the visible alt frame either way (§21.1); the auto path stays normal-buffer-only.
- **Main-process placement** means monitoring and injection keep working regardless of renderer state, and later survive the monitor pane moving to a separate process, or the renderer being remote.

### 8.2 Implementation sketch

- **`shadow.write()` is asynchronous** (parsed on a queue). Anything that must read the buffer *after* specific bytes are parsed uses the write callback; never read the buffer synchronously right after a `write()` and assume it is current.
- **Two timescales, two jobs.** An 80 ms settle debounce smooths redraw bursts before *reading* shadow state for status; the quiescence threshold (§8.3, default 1000 ms) is a *semantic* judgment that the agent has stopped. Merging them makes status laggy or quiescence trigger-happy.
- **Status is published on change only** (`monitor:update`), so consumers react to transitions rather than polling.

### 8.3 Quiescence detection

The agent is **`active`** while its **rendered screen keeps changing** and flips to **`quiet`** once the visible buffer has been unchanged for `APP_QUIET_MS` (default 1000 ms). Quiet is the "the agent is probably waiting for you" signal — surfaced in the monitor pane, the injection engine's "injectable" gate (§27.2), and the trigger the semantic scanner runs on (the `active → quiet` transition, not every output chunk).

- **Activity is a screen change, not a byte.** Only a write that changed the visible viewport text counts. Byte presence pinned a full-screen TUI agent that repaints an unchanged frame on a timer `active` forever, which stalled the §27.2 injection gate.
- **Quiet is a strong hint, not proof.** An agent can be thinking or waiting on the network without repainting (false quiet), and a TUI that genuinely animates while idle reads `active`. Claude Code animates a spinner while working and settles to a static input box when idle.
- **It tracks the agent, not the user.** Keystrokes don't reset the timer directly; only the echo/redraw they provoke does. A session at a quiet prompt stays `quiet` while the user types — the question is "has the agent stopped producing output".
- **Transitions, not levels, are the API.** Consumers subscribe to `monitor:update`; nothing polls the state.

#### 8.3.1 Waiting — a quiet screen whose agent still has a command running

An agent that starts a long command (a test suite, a build) and returns to a static prompt reads `quiet`, which looks the same as "finished". **Waiting** is a third, **display-only** activity for that case: while the screen is `quiet` and a command the agent started is still running, the terminal shows **Waiting · `<program>`**. It never changes `active`/`quiet` or anything that reads it — the §27.2 injection gate, the semantic scanner and the §27.12 stall watchdog behave exactly as without it, and a running command neither extends nor resets the watchdog.

- **Who is the agent, and what is a command.** The agent is the shell's foreground process group, led by its leader; when the shell itself is in the foreground there are no commands. A **command** is a process the agent's leader started in a process group of its own and off the agent's terminal (a new session, or a pseudo-terminal of its own), that is over a second old (an elapsed reading of 2 s, because macOS rounds `ps` time up and procps truncates it) and is no helper. Its descendants belong to it. Every process in the agent's group, and everything such a process starts, is part of the agent — a stdio MCP server and the browser it launches are never commands. A process re-parented away from the agent (`nohup … &` whose shell exited), or one a harness runs under a daemon that is not the agent's descendant, is not seen, and such a terminal reads Idle.
- **The label is the program name the OS reports**, never the command line, so no argument ever leaves the process table. A command whose program is a shell is labelled by its first child (earliest started), or by the shell's own name when it has none. Several commands show the earliest-started one plus a count: `node +1`. Names are the OS's executable names, truncated at 15 characters on Linux and 16 on macOS.
- **Helpers.** A candidate is a helper, and never a command, when it — or the process its label comes from — has a listed helper program name, or has an empty name. The built-in list (`src/main/waitingRule.ts`) holds `codex-code-mode-host`. The operator may add names in `helper-programs.yaml` in the app-state home's `.agent-terminal/` directory (§23.4): a YAML list of program names, which the app only reads. A listed name matches a process when it equals that process's program name after both are cut to the OS's name limit. A missing file adds nothing. A broken one (unreadable, not YAML, not a list of strings) adds nothing and logs one warning naming the file to the main-process log each time its content or read error changes. The file is re-read at most every 15 s, so an edit takes effect within about 20 s, with no restart.
- **Timing.** Lookups run only while the screen is `quiet`, one at a time, `WAITING_POLL_GAP_MS` (1000 ms) after the previous one settles. Each runs `ps` asynchronously with a fixed argv and is aborted, and its child killed, at `APP_WAITING_LOOKUP_TIMEOUT_MS` (default 1000 ms). A lookup that fails or times out reads as no commands, each distinct failure is logged once with no process text, and an answer that arrives after the screen turned `active` is ignored. A command under a second old never shows Waiting; one still running shows it within 5 s of its 1 s mark; the terminal leaves Waiting within 5 s of the last command exiting, and at once when the screen turns `active`. Off macOS and Linux no lookup runs and no terminal reads Waiting.
- **Grace on the controller only.** For `WAITING_GRACE_MS` (3000 ms) after an `active → quiet` flip, the controller status (§23.6) keeps reporting Working unless a lookup has already found a command, then follows the latest lookup. A command started just before the agent's screen settled therefore never shows a brief Idle on the card. The window's strips follow the latest lookup with no grace.
- **Where it shows.** The controller card, header counts, tray and timeline (§23.6); the monitor status strip's `agent` chip (`agent: waiting · <label>`, with no quiet counter) and the flow strip's derived line (`… · waiting · <label>`). `monitor:update` and the flow view's derived status each carry the Waiting value beside the screen state, and carry none while the screen is `active`. The value and its label have one definition, `src/shared/waiting.ts`.

### 8.4 Capture events (skeleton scope)

Main stamps every capture event and keeps the session's list, replaying it to a (re)loaded monitor pane. The list is persisted per launch directory at `<L>/.agent-terminal/monitor-events.json` so events survive an app restart in the same directory, however the prior instance ended. The app never writes `.gitignore`; ignoring `.agent-terminal/` is the user's choice (§19.1).

The file is an **untrusted** source — a cloned repo can ship one — so:

- each element is validated to the §15.4 event shape on load, and malformed entries are dropped;
- the file is refused above a size cap (CWE-400);
- the write uses an unpredictable temp name and exclusive create, so a planted symlink cannot redirect it (CWE-59);
- inject-able `command-output` events (§16.2) are dropped on restore, so the file cannot seed an Insert-at-cursor card (CWE-78). This drop is **permanent, not a phase limit**: a restored file is indistinguishable from an attacker-shipped one, so even a user's own earlier command output never restores.

Restored non-inject-able events (capture/finding/completion) stay viewable and addable to todos. Their text can still reach the prompt through Add-to-todo → todo Insert, but only without submit and only by deliberate multi-step user action — that visible, manual path is the **accepted boundary**.

The list is unbounded — an accepted limit.

---
