# Handoff — code gate

The implementation-phase consolidated review has just gone **clean**. The orchestrator is about to exit for human PR review. You (consolidator) have the full context of every persona's code review in your session.

Produce a **human-facing report** as your next message. Structure it exactly like this:

## Code review: ready for PR review

- **PR:** #{{PR_NUMBER}} — {{PR_TITLE}}
- **Iteration:** {{ITERATION}}
- **Personas that ran:** list them.
- **Plan file:** `.agent-loop/plan.md`
- **Commits produced this phase:** short list of commit subjects.

### What changed
One short paragraph describing the shape of the implementation, grounded in the actual diff (files touched, new capabilities, tests added).

### Personas clean
- Bullet list of persona names that returned `clean` with no kept findings.

### Minor findings kept (non-blocking)
- For each: `[persona] severity=minor — file:line — message. Suggestion: …`
- If none, write "None."

### Notable dismissals
- For each: `[persona] [severity] — "message" — dismissed because: "dismissal_reason".`

### What a human should double-check
- 2–4 concrete things tied to the *diff* — e.g., "foo.go:42 changes the error wrapping; verify upstream callers still match," "migration at 004 is reversible per pattern in 003."

### Test evidence
- Test suite run (name, command, result).
- New tests added (count + names).
- Any tests the work agent pre-existing that now cover new behavior.

### Next steps
Approve + open the PR for team review:
```text
/agent-loop-approve
```
Send changes back to the loop:
```text
/agent-loop-request-changes <reason>
```
The reason is required.

---

Keep the whole report tight — the human is about to read it as the first thing they see on resuming the session.
