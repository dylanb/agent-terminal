## 1. Purpose

Build the minimal working foundation of an application for **running, monitoring, and steering coding agents** that live in a terminal. The user runs an agent CLI (Claude Code, Codex, aider, …) inside a hosted shell session; the application watches the agent's output, captures relevant pieces of it into a second UI, and lets the user act on what they see there — with those actions flowing back into the agent as terminal input.

The foundation must prove this **full loop** end-to-end, in its smallest form:

1. Run an interactive **shell** session (the agent's host) using the user's own shell configuration, attached to a real PTY.
2. Render the live terminal inside a **web UI** (the user can run the agent hands-on, exactly as in a native terminal).
3. **Tee** all PTY output into a main-process **shadow screen model** that tracks the live screen state, terminal modes, and output activity (quiescence) — the substrate for all monitoring and capture.
4. Let the user **select any region** of terminal output and either **send it back to the agent** or **capture it into the monitor pane**.
5. Show captured output in a **monitor pane** (the second UI) whose actions — *insert into agent*, *insert & submit* — inject text into the agent's input through a renderer-independent, bracketed-paste-aware path.

Automated/semantic capture (recognizing agent questions, tool calls, diffs, etc.) is **out of scope** here; the skeleton proves the plumbing those features will ride on. Manual capture (user-selected regions) stands in for it.

---

