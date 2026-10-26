## 16. Action window — tabs, todo lists, and layout

The monitor pane is the **action window**: a tabbed surface whose **Capture** tab holds the one captured report (§15, §21.1) and whose **Todo** tab is a persistent, repo-scoped work queue. It obeys §9.1 — it talks only to `window.monitor.*` / main-process APIs, never to the terminal pane or its xterm state, which is what keeps it relocatable. The same two tabs are the body of the quick-send overlay (§22.2).

### 16.1 Tabs

- **Capture** (session-scoped, §15) and **Todo** (persistent, repo-scoped, §16.3).
- The Capture tab shows an unread dot when a capture arrives while another tab is active; the Todo tab shows the count of todos not yet done.
- The last-selected tab is remembered **globally**, not per repo (§16.6).

### 16.2 Injection model

- **Captures never inject.** A report or finding offers **Add to todo**; injection happens only from the Todo tab. Curating first is the point: the curated todos are what feed the request-changes feedback (§19.4).
- **Add to todo is undoable in place** for a minute. Undo deletes the just-added todo by its own `repoKey` and restores the action; the source capture is never dismissed by an undo.
- Other surfaces (the Artifacts view, §20.2) add todos too and announce it on the renderer's decoupled window-event bus, so the repo-scoped count refreshes at once without coupling those views to the action window.
- **Todo items** offer **Insert** and **Insert & submit** (§9.3).
- **Focus rule:** **Insert** moves focus to the terminal (the user finishes and submits in the agent); **Insert & submit** leaves focus in the action window (fire-and-forget — keep curating).

### 16.3 Todo data model, scope, and persistence

- **Status is tri-state** — `active`, `in_progress`, `done` (`TodoItem`, `src/shared/ipc.ts`).
- **Scope = git repo root** of the agent's cwd, so every subdirectory of one repo shares one list; a non-repo cwd keys on the directory itself. Before the first cwd report the scope is the launch root (§23.4).
- **cwd tracking uses OSC 7**, emitted by the shell integration (§15.5) on each prompt and parsed from the shadow in main; `cwd:changed` is broadcast only when the repo key changes.
- **Persistence is an in-repo file**, `.agent-terminal/todos.json` at the repo root, written atomically. A missing or corrupt file degrades to an empty list, never a throw. The app never modifies `.gitignore` — committing the file is the user's choice (CODE-STANDARDS.md).
- **Every todo mutation carries its target `repoKey`.** A `cd` swaps the displayed list silently, except while an edit is open: then the swap waits until the edit is saved or cancelled. Together these mean an in-flight edit always writes to the repo it belongs to.

### 16.4 Todo tab interactions

- Manual add appends to the bottom. Reorder by drag handle **and** up/down buttons (keyboard access). Text is edited in place (Enter commits, Escape cancels); edits never touch the source capture.
- Checking a todo marks it `done`; done todos stay inline, dimmed, in the one list. Only the newest `APP_MAX_DONE_TODOS` (default 50) done todos are kept — older ones are pruned on write, so a long-lived repo's list does not grow without bound.

### 16.5 Self-injection suppression

- Text the app injects (either path, §7.5 and §9.3) echoes back into the session and must not be captured as a report; the agent's **reply** to it must be.
- **Byte-matching cannot do this.** Claude Code renders long pasted input as a `[Pasted text #N +k lines]` placeholder, so the echoed bytes differ from the injected ones.
- So injection drops a **shadow marker at the cursor row before the echo returns** — exactly where the echoed input renders — with a timestamp. A detected region containing a live marker is the user's own input and is not captured; the reply renders below it and is. A marker retires when its row trims out of scrollback or the window (`APP_SELF_INJECT_WINDOW_MS`) lapses; the window must outlast the gap between the echo and the agent's reply finishing.

### 16.6 Global UI settings

UI preferences — last tab, theme, artifact-tree widths (`UiSettings`, `src/shared/ipc.ts`) — are **app-wide, not per repo**, so they persist to `ui-settings.json` under Electron's `userData`, the one piece of app state kept outside the repo.

### 16.7 Out of scope

- Persisting or exporting captures (§13.6).
- Syncing todos across machines, exporting them, or reconciling a committed `todos.json` across branches and merges.

### 16.8 Cross-highlight between the terminal and the capture pane

The capture pane and the terminal show the same content at different places, so a double-click on either jumps to the other. Both directions ride the renderer's decoupled window-event bus, so the capture pane never imports terminal modules (§9.1).

- **The terminal owns the coordinates, anchored by markers.** A capture's range is in scan-time absolute rows, and a window resize reflows the transcript so those rows then name different content. The capture pane therefore holds only capture **ids**: it publishes each rendered capture's span, the terminal anchors xterm markers to the first and last rows, and markers follow their lines through scroll and reflow (§7.4). A report and each of its findings carry their own span.
- **Terminal → capture:** the double-clicked row resolves, against the markers' live lines, to the **most specific** covering capture (a finding before its report); the capture pane scrolls to it and outlines it briefly.
- **Capture → terminal:** the terminal scrolls to the capture's current marker rows and draws a self-clearing amber highlight, on its own decoration list so it never clears the user's selection.
- **Best-effort.** These coordinates are never used to re-extract content (§7.3). A capture whose rows have trimmed out of scrollback highlights nothing; a capture with no range anchors nothing.

---
