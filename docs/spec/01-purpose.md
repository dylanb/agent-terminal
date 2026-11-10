## 1. Purpose

An application for **running, monitoring, and steering coding agents** that live in a terminal. The user runs an agent CLI (Claude Code, Codex, aider, …) inside a hosted shell session; the application watches the agent's output, captures relevant pieces of it into a second UI, and lets the user act on what they see there — with those actions flowing back into the agent as terminal input.

The foundation is a **full loop**:

1. Run an interactive **shell** session (the agent's host) using the user's own shell configuration, attached to a real PTY.
2. Render the live terminal inside a **web UI** (the user can run the agent hands-on, exactly as in a native terminal).
3. **Tee** all PTY output into a main-process **shadow screen model** that tracks the live screen state, terminal modes, and output activity (quiescence) — the substrate for all monitoring and capture.
4. Let the user **select any region** of terminal output and copy it, independent of which pane has focus (§7).
5. Show captured output in a **monitor pane** (the second UI) whose actions inject text into the agent's input through a renderer-independent, bracketed-paste-aware path (§9.3).

Semantic capture (§15), todo lists (§16), and task-flow management (§17–§28) build on this loop.

---
