## 25. Flow audit record (per-run, append-only)

### 25.1 Goal & boundary (D-audit-1)

Each flow run writes a durable, human-auditable record from which a **complete timeline** of the run can be reconstructed: lifecycle state changes, the TODOs and their state changes, loop inputs/outputs, the ticket and PR involved, loop status/iteration, and the commands the flow issued on the user's behalf.

**Boundary:** auditing is **observe-only** and **best-effort**. It injects nothing, blocks nothing, and **never throws into the flow path** — it only records what the flow lifecycle, the TODO store and the loop engine's run state already produce. A failed audit write is logged and dropped; the flow proceeds unaffected.

"Development complete" at finalize is a reporting convention only: it emits no `flow.completed` and never substitutes for the human completing the flow.

### 25.2 Storage layout (D-audit-2)

Audit root: `~/.agent-terminal/audit/`, one directory per repo **basename**, one file per `flow:start`. File names carry a millisecond UTC timestamp so two Starts of one flow in the same second never share a file. The repo basename and flow name are reduced to filesystem-safe segments because a `flow.yaml` `name:` is untrusted repo input and must not traverse the audit tree (CWE-22).

### 25.3 File format — YAML multi-document stream (D-audit-3)

A header document, then one `---`-delimited document per event, so appending an event is **O(1)** — never a rewrite of prior content. "A reader never sees a partial event" rests on each event being one append **plus** the reader discarding a trailing partial document (possible only on a crash mid-append), not on atomic rename.

Event `ts` is ISO 8601 UTC with milliseconds; the header's `started` is ISO 8601 UTC to the second. Readers keep events in file order, place windows by parsing `ts`, and never compare a `ts` with `started` as strings; a run is matched on `started`'s exact second-precision text (§25.6).

### 25.4 Lifecycle (D-audit-4)

- A fresh `flow:start` opens a new file, closing any current run for that repo; advance/restart/undo and a rollback after a failed start append to it.
- Reaching `done` records `flow.completed` but **keeps the file open**, so going back after completing a flow continues the **same** record.
- Terminate appends `flow.terminated` and finalizes the run, so the next Start always opens a new file.
- The current-run pointer **survives an app restart**, so a restart mid-run does not orphan the record.
- TODO events are recorded **only while a run is open** for the repo.
- Each time a step's window closes (§27.16), the record gains a `step.tokens` entry with that step's counts so far, whether or not counts are shown, timed at the close it reports. The count is read after the close, so the entry may follow `flow.completed` or `flow.terminated`. Reconstruction (§25.6) takes each step's final counts from the entry for its last closed window, reads a step whose entry is missing as unavailable, and derives the run total from them; a record with no such entry has no counts.

### 25.5 Event vocabulary (D-audit-5)

The vocabulary is the `AuditEvent` union in `src/shared/audit.ts`. Ticket/PR numbers come only from resolved inputs and the loop engine's run state (§25.7). A §27.9 gate-decision `command` entry the engine decided carries an engine-decided mark; one without it was decided by a human. An `auto` halt records every reason that holds (§27.9.1 N9b.9). `ticket.assoc` carries an optional `repo` (`<owner>/<name>`): a run that adopts a pull request (§27.10) records its primary ticket with that ticket's repository, since a head-repository ticket's number can equal one in the base repository; a ticket run's entry has no `repo`, and an entry without it still parses. A `decision` event records the value a deciding step's approve took (§18.2), written only when the flow recorded it.

### 25.6 Shared semantics & timeline reconstruction (D-audit-6)

The writer, the tests, the installed agent runtime and any viewer must agree on the event vocabulary, the file-path derivation, the serialize ↔ parse pair and the timeline reconstructor, so each has **one** shared definition (CLAUDE.md shared-semantics rule). The reconstructor tolerates a trailing partial document and yields the ordered timeline plus the folded final state — the "a complete timeline can be reconstructed" criterion.

When the installed runtime reads a run's evidence for a finalize report, it checks the header's absolute repo path, flow and start time, so a basename collision cannot supply another run's evidence. Missing or mismatched history is reported as unavailable, never invented.

### 25.7 Constraints & accepted limitations

- **Never throws into the flow path.**
- **Untrusted strings.** TODO text and repo/flow names are YAML-quoted on write and path segments are sanitized (§25.2). The loop-output snapshot is realpath-confined to the repo so a symlink cannot escape it.
- **Basename collision** across same-named repos is **accepted** — run files co-mingle in one directory, but the current-run pointer is keyed by the **full** repo path so each repo tracks its own run.
- **Explicit ID sourcing only** — ticket/PR numbers never come from branch-name or PR-body scraping.
- **Retention:** keep all, no pruning.

---
