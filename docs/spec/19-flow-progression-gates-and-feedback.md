## 19. Flow progression, gates & feedback

### 19.1 Flow-state & loop progress (D1/D33)

- `flow-state.yaml` records the current step, per-step status, and gate state. The bound loop engine supplies **loop progress** (iteration, latest verdict; §27.2) for the status strip (§22.3).
- `flow-state.yaml` also records `decisions`: for each step that declares `decides:` (§18.2) and has been approved, the value its loop decided and an optional `note`, keyed by step id. A relaunch resumes on the path those values chose. A run whose persisted step the current definition no longer has starts fresh, and its recorded decisions are dropped with it. A recorded `note` is read by the decision file's note rule (§18.2): escapes and control characters are removed and surrounding space trimmed, and a note that is then empty or longer than 60 characters is dropped while its value is kept. A malformed `decisions` value reads as no decisions, so the steps waiting on it are undecided again. On every read the machine keeps only the decisions whose value the current definition's step still declares in `decides:`, so a value for a step that is gone, no longer decides, or no longer declares that value is dropped. A run whose current step, or a later step, then waits on a deciding step it has already passed is not resumed, since nothing can record that step's decision any more: the strip shows the flow-load error (§18.1) naming the step, and the dropped value when there is one, and offers Terminate. Nothing is written, so putting the value back in flow.yaml resumes the run where it was. A decision an approve records also carries `gate_turn`, the turn key of the gate it was recorded at, and counts only once the loop's run state (§27) records that gate turn as accepted; until then the run reads as if the step had not decided. The Advance that moves off the step writes the decision without `gate_turn`, so it no longer depends on the run state, which the next step's loop replaces. A `gate_turn` that is not a non-empty string drops its decision on the read, and the strict read a title write makes refuses the whole document.
- **VCS:** the app **does not** modify `.gitignore` — for `flow-state.yaml`, the audit pointer, or any app-owned `.agent-terminal/` file (matching the todoStore, §16.3). Whether to ignore or commit `.agent-terminal/` (so progression travels with a branch) is the user's choice; the production system never edits the user's VCS config.

### 19.2 Advance is user-driven, with a not-ready warning (D31)

- No step advances without a gate decision — a human's, unless the step's `gate_authority: auto` is honoured (§27.9.1). The app tells the user whether the current step's gate is satisfied; advancing on an unsatisfied gate **warns** but **proceeds** (human override). Entering a step runs its entry actions (§18.3/§18.6).

### 19.3 Gate driver & the running-process refusal (D2/D32)

- Gate actions execute in-app (§27.9): the app runs the transition and its side-effects directly (§27.13), then reconciles from its own loop state (§19.1).
- **Injection refuses while a foreground process is running** — the shell is not at a ready prompt (detected via §8.3 quiescence / OSC-133 marks). The app **stops and tells the user what to do** ("agent is busy — wait or interrupt, then retry") rather than typing over a live process. The same rule governs `action` commands (§18.2) and `bootstrap` (§18.3).

### 19.4 Request-changes feedback (D7/D9/D11)

- Only loop steps take request-changes. At the gate the user **selects which review todos** to include (a curated subset — sourced via §21.1 capture → Add-to-todo), optionally **adds free-text instructions**, and chooses **"Compose with agent"** (selected todos + instructions → agent writes the reason, framed for the next review-and-fix round, §27.9) **or "Submit todos as-is"** (verbatim). The gate driver (§19.3) submits the reason in-app — no terminal injection.

---

