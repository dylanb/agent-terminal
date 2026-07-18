## 2. Scope

### In scope
- Spawn one interactive shell process attached to a real pseudoterminal (PTY). Agents are launched by the user *inside* this session (e.g. typing `claude`).
- Honor the user's shell startup files (for bash: `.bashrc` / `.bash_profile` / `.profile`) per platform convention.
- Stream PTY output to an `xterm.js` terminal in the UI; stream user keystrokes back to the PTY.
- **Tee PTY output** into a main-process `@xterm/headless` shadow terminal: live screen model, bracketed-paste-mode tracking, alternate-screen detection.
- **Quiescence detection** (§8.3): track whether the agent's output stream is **active** or **quiet** and publish transitions to the monitor pane — the "agent is probably waiting for you" signal, and the trigger the future semantic pipeline will scan on.
- Full color (256-color / truecolor) and correct resize/reflow behavior (renderer and shadow stay in lockstep).
- Mouse text selection in the terminal (app-owned, focus-independent model); driven entirely by the keyboard — Copy via the keymap (§7.7), Clear via Escape while a selection is active (§7.5.1).
- A minimal **monitor pane**: lists captured blocks and live session status (working/quiet activity, alt-screen and bracketed-paste indicators); each block offers **Insert into agent** and **Insert & submit** actions.
- A main-process **injection API** (`agent:inject`) used by the monitor pane: wraps text per the *live* bracketed-paste mode read from the shadow model, optionally appends a submit (`\r`).
- Graceful handling of shell exit and window close.

### Out of scope (this version)
- **Semantic/automatic capture** — heuristics that recognize agent prompts, questions, tool-use blocks, diffs, or status regions. (The shadow model is the substrate for this; the heuristics come later.)
- Running the monitor pane as a separate process/web app (`WebContentsView`); in the skeleton it is a pane in the same renderer, but it is **architecturally constrained** to talk only to main-process APIs so it can be moved out later without change (§9.1).
- Multiple concurrent agent sessions / tabs / split panes. (IPC payloads carry a `sessionId` from day one so channels don't need redesign — §6.)
- SSH or remote sessions. (A non-bash login shell is hosted fine — it simply runs without the §15.5 OSC 133 shell-integration hooks, which install only for bash.)
- Windows support.
- Persistence of captures, scrollback export, theming UI, settings screens.

---

