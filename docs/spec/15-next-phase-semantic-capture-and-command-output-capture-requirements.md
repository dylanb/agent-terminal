## 15. Semantic capture & command-output capture

Two capture families share the monitor's event plumbing: **agent reports** recognised in the agent's output, and **ordinary command output** delimited by shell-integration marks. Both feed the user's todo curation (§16, §21); neither acts on what it finds.

### 15.1 Goal & boundary

- Capture is **manual and single-slot**. The user clicks **Capture last report**; the scanner runs once, on demand, against the current shadow buffer and returns the latest report, which replaces any prior capture (`capture:last`, §21.1).
- A `report` carries **findings** — one per top-level list item, one per non-list paragraph — each individually addable as a todo.
- **Detection only, no autonomy.** Nothing is answered, approved or submitted on the user's behalf.
- **No question / permission-prompt detection.** It false-positived on report prose and on code or diff lines that merely contain `?` or "do you want".
- **Self-injected text is never captured back** (§16.5); the agent's *reply* to it still is.

### 15.2 Trigger, data source, and scan scope

- The scanner reads only the shadow's public read path, in the **main process**, so capture works with the renderer unfocused, reloaded, or relocated (§9.1).
- **Wrapped-line fidelity:** rows flagged `isWrapped` are joined, so captured text keeps its logical lines rather than hard breaks at the terminal width.
- Shadow and renderer scrollback stay pinned to the same size (§8.2). Raising only the shadow's scrollback to capture more would break coordinate provenance (§7.3).

### 15.3 Agent-semantic detection

- **Capture is decided by a glyph-agnostic baseline, never by per-agent glyph patterns.** The baseline captures contiguous runs of substantial non-chrome prose as a report; a themed or version-changed bullet glyph (`⏺`→`●`) therefore can never cost a capture.
- **A box is content, not chrome.** Claude frames real summaries in boxes; the frame is a separator, the text inside is captured.
- **Per-agent classifiers only enrich.** The Claude Code classifier types its deterministic blocks (`⏺ Name(args)` tool calls, `±` diffs) as `tool-use` / `diff` and carves those rows out of the baseline. A classifier can never suppress capture — if its glyphs stop matching, the baseline still captures the prose. Every classifier runs every scan; there is no adapter selection that could claim a region and then drop it.
- A report below `APP_REPORT_MIN_CHARS` is not a report, so one-liners and short command output stay out.
- **Alt-screen agents** (Claude Code, Codex TUI): on-demand capture reads the visible alternate-screen frame. Precise structural parsing of alt-screen regions is deferred (§13.4).

### 15.4 Event contract

Captures are `MonitorEvent`s (`src/shared/ipc.ts`). `text` is the durable payload, extracted at capture time; `range` is best-effort provenance and is never used to re-extract (§7.3). A `finding` links to its `report` by `parentId`.

### 15.5 Command-output capture (shell integration)

- **Segmentation uses OSC 133 shell-integration marks** (the FinalTerm / iTerm2 / VS Code convention: prompt start, command start, output start, finished-with-exit-code), never prompt-matching heuristics — user prompts vary too much, and agents print prompt-looking text constantly.
- **The integration is injected through an environment-variable hook that runs after the user's own startup files**, not `--rcfile`/`--noprofile`, so the user's configuration still loads (§5). Disable it with `APP_SHELL_INTEGRATION=0`. xterm ignores unhandled OSC, so the marks are invisible.
- **When marks are absent** (the user `exec`s another shell, SSHes away, or opts out), command segmentation is simply unavailable — there is no heuristic fallback. Agent-report capture is unaffected.
- The command tracker is main-process only. It marks which scrollback rows are finished command output, so the baseline does not mistake them for a report, and it reports whether an agent CLI is the foreground command (§27.2). An agent launched as a command is itself one delimited span.

### 15.6 Monitor pane

The Capture tab shows the single captured report with its findings in natural order; each finding, and the report as a whole, offers **Add to todo** (§16.2). Captures do not inject — injecting happens from the Todo tab. Unknown event types render as a generic block, never dropped. The pane talks only to `window.monitor.*` (§9.1).

### 15.7 Configuration & tuning

Thresholds are environment-overridable and live in `src/main/runtimeConfig.ts`. The Claude Code classifier can be switched off (`APP_ADAPTER_CLAUDE_CODE=0`) as an escape hatch when a new agent version breaks its glyph match; only the enrichment is lost.

### 15.8 Testing

Detection tests drive the real `@xterm/headless` shadow with scripted byte streams (recorded from real Claude Code / Codex sessions where possible) and assert on the captured events, never on which detector matched. **False-positive budget:** a plain bash session running ordinary commands yields no agent report.

### 15.9 Out of scope

- Acting on captures automatically (answer buttons, approve/deny).
- Persisting or exporting captures (§13.6).
- ML/LLM classification — capture stays deterministic and testable.
- Heuristic (mark-less) command segmentation; precise alt-screen region parsing (§13.4).

---
