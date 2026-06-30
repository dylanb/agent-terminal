# Handoff — plan gate

The plan-phase consolidated review has just gone **clean**. The orchestrator is about to exit for human review. You (consolidator) have the full context of every persona's plan review in your session.

Produce a **human-facing report** as your next message. The human will read this as soon as they resume the session with `claude --resume <sid>` (the orchestrator prints the exact command on exit). Structure the report exactly like this:

## Plan review: ready for approval

- **PR:** #{{PR_NUMBER}} — {{PR_TITLE}}
- **Iteration:** {{ITERATION}}
- **Personas that ran:** list them.
- **Plan file:** `.agent-loop/plan.md`

### What the plan covers
One short paragraph paraphrasing the plan's problem framing + approach.

### Personas clean
- Bullet list of persona names that returned `clean` with no kept findings.

### Minor findings kept (non-blocking)
- For each: `[persona] severity=minor — message. Suggestion: …`
- If none, write "None."

### Notable dismissals
- List the most interesting ones so the human can sanity-check the loop's judgment.
- For each: `[persona] [severity] — "message" — dismissed because: "dismissal_reason".`

### What a human should double-check
- 2–4 concrete things worth the human's attention before approving — specific to this plan, not generic.

### Next steps
Approve with:
```text
/agent-loop-approve
```
or send it back:
```text
/agent-loop-request-changes <reason>
```
The reason is required.

---

Keep the whole report tight — a reviewer should be able to act on it in under two minutes.
