## 19. Flow progression, gates & feedback

### 19.1 Flow-state & loop progress (D1/D33)

- `flow-state.yaml` records the current step, per-step status, and gate state. The bound loop engine supplies **loop progress** (iteration, latest verdict; §27.2) for the status strip (§22.3).
- **Reading repository files.** Every file the app reads from a working tree is read through one descriptor opened without blocking: the app's own `.agent-terminal/` state, loop artifacts, and the flow and loop files a repository supplies. A named pipe, a device or any other non-regular file is refused, never read, as is a file that is not valid UTF-8 or that is larger than its limit:
  - 4 KiB: the turn-done file;
  - 64 KiB: the repository's `.agent-loop.yaml`;
  - 256 KiB: `flow.yaml`, a loop definition, a recipe, a brief, a reviewer charter, a todo template;
  - 512 KiB: a file the artifact viewer opens (§20);
  - 1 MiB: a loop-area state file, `todos.json`, a report section and the assembled report;
  - 2 MiB: the epic plan read at its approve gate;
  - 8 MiB: the RED check report;
  - 16 MiB: any other loop artifact, a phase's captured run included, and the monitor's events file.

  A refused file takes the path an unreadable one takes: a reason where the reader reports one, otherwise nothing is used (a missing done signal, an empty todo list, a template named after its file).
- **VCS:** the app **does not** modify `.gitignore` — for `flow-state.yaml`, the audit pointer, or any app-owned `.agent-terminal/` file (matching the todoStore, §16.3). Whether to ignore or commit `.agent-terminal/` (so progression travels with a branch) is the user's choice; the production system never edits the user's VCS config.

### 19.2 Advance is user-driven, with a not-ready warning (D31)

- No step advances without a gate decision — a human's, unless the step's `gate_authority: auto` is honoured (§27.9.1). The app tells the user whether the current step's gate is satisfied; advancing on an unsatisfied gate **warns** but **proceeds** (human override). Entering a step runs its entry actions (§18.3/§18.6).

### 19.3 Gate driver & the running-process refusal (D2/D32)

- Gate actions execute in-app (§27.9): the app runs the transition and its side-effects directly (§27.13), then reconciles from its own loop state (§19.1).
- **Injection refuses while a foreground process is running** — the shell is not at a ready prompt (detected via §8.3 quiescence / OSC-133 marks). The app **stops and tells the user what to do** ("agent is busy — wait or interrupt, then retry") rather than typing over a live process. The same rule governs `action` commands (§18.2) and `bootstrap` (§18.3).

### 19.4 Request-changes feedback (D7/D9/D11)

- Only loop steps take request-changes. At the gate the user **selects which review todos** to include (a curated subset — sourced via §21.1 capture → Add-to-todo), optionally **adds free-text instructions**, and chooses **"Compose with agent"** (selected todos + instructions → agent writes the reason, framed for the next review-and-fix round, §27.9) **or "Submit todos as-is"** (verbatim). The gate driver (§19.3) submits the reason in-app — no terminal injection.

---

