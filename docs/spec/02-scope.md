## 2. Scope

### Standing constraints
- One interactive shell process attached to a real pseudoterminal (PTY) per window. Agents are launched by the user *inside* this session (e.g. typing `claude`); the shell, not the agent, is the session (§5).
- The user's own shell startup files are honored per platform convention (§5).
- Renderer and shadow terminal stay in lockstep on output and resize, so what the app reads is what the user sees (§8).
- The terminal selection is app-owned and focus-independent (§7).
- The monitor pane talks only to main-process APIs (§9.1), so it stays relocatable to a separate process.
- Injection reads the *live* bracketed-paste mode at injection time, never a cached one (§9.3).

### Out of scope
- SSH or remote sessions. (A non-bash login shell is hosted fine — it simply runs without the §15.5 OSC 133 shell-integration hooks, which install only for bash.)
- Windows support.
- Running the monitor pane as a separate process/web app — deferred, but the §9.1 rule keeps it a relocation rather than a rewrite.

---
