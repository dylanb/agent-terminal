---
description: Groom a GitHub ticket so the agent-loop plan/impl phases waste fewer cycles. Usage — /groom-ticket <issue-number>.
---

Walk an operator through a structured grooming pass on a GitHub issue used as input to an agent-loop run, propose concrete edits to the issue body, and — after the operator approves them — apply them to GitHub and mirror them to `.agent-loop/ticket.md`.

The command is **interactive**. It uses `AskUserQuestion` per concern surfaced. It does **not** silently rewrite the ticket: every change is shown and approved.

## Guiding principle

**When in doubt, err toward under-constraining the implementation.** ACs should specify the *measurable outcome* a reviewer can enforce, not the implementation choices the impl agent makes. Names, file layouts, mechanism choices, documentation artifacts, and pixel-level visual details belong in pins, preambles, or referenced design locks — not in the ACs themselves.

The exception is **technical-by-nature tickets** where the implementation details *are* the acceptance criteria: a database migration with a specific SQL shape, a protocol implementation with a fixed wire format, an algorithm whose pass condition is its exact behavior on enumerated inputs. For those, the technical details belong in the ACs.

At the start of Q2, ask the operator once whether the ticket is technical-by-nature. If yes, narrow the over-constraint scan; if no (the default), apply the full catalog. The bias is otherwise always toward giving the impl agent latitude — a reviewer can enforce the behavior, but an impl agent that has to negotiate around an unnecessary constraint produces churn.

## Argument

`/groom-ticket <issue-number>` — the integer GitHub issue number to groom. If the argument is missing or non-numeric, ask the operator for it once via `AskUserQuestion`. If they decline, stop.

## Sequence

### 1. Load ticket + context

Run these in parallel:

- `gh issue view <n> --json number,title,body,state,labels,url,milestone,assignees,comments` — capture the canonical issue body as the editing baseline.
- `agent-loop status` (best-effort; ignore non-zero exit) — note if an agent-loop is mid-run; if so, also read `.agent-loop/ticket.md` to detect drift between the GitHub body and the local copy.
- `git log --oneline -20` and `git log --oneline --since='14 days ago' -- docs/standards docs/decisions docs/specs` — recent changes to standards / specs / decisions the ticket may reference.

Save the GitHub body verbatim to `.agent-loop/groom-baseline.md` (create `.agent-loop/` if it doesn't exist — and only if the working directory is inside a git repo; if not, use a temp file under `$TMPDIR` and tell the operator). This file is the editing baseline and will be deleted at the end of the run regardless of outcome.

If the issue is **closed**, ask the operator once whether to proceed; default answer is to stop.

### 2. Surface drift

Before any grooming question, do a fast static scan of the ticket body and report findings to the operator as **a single combined readout**, then ask one `AskUserQuestion` whether to continue. Cover:

- **Tombstoned / renamed symbols.** Grep the body's referenced file paths and identifiers against the current repo (`rg` / `grep`). Anything in the body but missing from `HEAD` is flagged — these are the highest-yield grooming targets.
- **ticket.md ↔ GitHub drift.** If `.agent-loop/ticket.md` exists, diff it against the baseline body and report whether they agree.
- **Linked tickets state.** For each `#<n>` referenced in the body, run a single `gh api graphql` query (or batched `gh issue view` calls) to capture state (open/closed/merged). Closed referenced tickets are not automatically a problem, but the operator needs to know.
- **Standards referenced.** Pull the list of `docs/standards/*.md` and `docs/decisions/*.md` paths cited and note any that have been edited within the last 14 days — those are most likely to have moved out from under the ticket.
- **Internal drift (pin contradictions).** Scan the body for *pin patterns* — statements that grant the impl agent latitude (e.g., "symbol names are illustrative", "file count is impl's call", "mechanism is impl's call", "documented somewhere reviewable in the PR"). For each pin, check whether other ACs in the same ticket mandate the very thing the pin granted latitude on. Flag pin↔AC contradictions as a finding — they are the highest-yield over-constraint signal and seed Q5 below.

If drift is severe (e.g., the body cites a file/symbol that no longer exists), recommend that the operator fix those first before continuing — the grooming pass will be more useful afterwards.

### 3. Walk the grooming questions

Run the questions below **in order**. For each one:

1. **Analyze the ticket** against the question. Be specific: cite line ranges, AC numbers, or exact quoted phrases from the body. Do not paraphrase — paraphrasing hides exactly the kind of churn-inducing wording this skill exists to catch. For every finding, also identify any **parallel ACs** in the same ticket that should be checked against the same finding — over-constraints rarely live alone, and cross-AC inconsistency is itself a finding.
2. **Decide whether the ticket has a problem at all** for this question. If not, say so in one sentence and move on — do not invent problems. Default to the under-constraining bias: when a constraint *could* go either way, recommend lifting it; reviewers can always add it back if behavior alone proves insufficient.
3. If there is a problem, **propose a concrete edit** (before/after) inline in the chat. Frame the proposal so the reviewer can still enforce the outcome but the implementor has implementation latitude — that is the whole point of the exercise.
4. **Ask the operator** via `AskUserQuestion`: "Apply this edit? / Revise — I'll explain / Skip this finding / Other". For "Revise" or "Other", capture the operator's free-text rationale and re-draft, then re-ask.
5. **Accumulate accepted edits** in memory; do not write to the body yet.

Per question, ask one `AskUserQuestion` per concrete finding so the operator can decide each on its own — collapsing multiple over-constraints into one prompt re-creates the wall-of-text problem the skill exists to prevent. If a single question produces more than ~6 findings, keep the first ~6 as individual prompts and batch the tail into one grouped question with a "review all in detail" / "skip all" affordance. There is no global cap.

The questions, in order:

#### Q1 — Relevance

Is the ticket still completely relevant given the current state of the repo and the decisions that have been made since it was written? Look for: closed/merged dependencies, retired symbols, decisions (ADRs) that have superseded what the ticket assumes.

#### Q2 — Over-constraint catalog

Do the ACs over-constrain the implementation when a measurable outcome would suffice? **Before scanning**, ask the operator once via `AskUserQuestion` whether the ticket is technical-by-nature (migration with a specific SQL shape, protocol implementation with a fixed wire format, algorithm with enumerated input/output pairs, etc.). If yes, narrow Q2 to row 1 only (symbol naming). If no — the default — apply the full catalog.

Scan every AC against this catalog. Each shape below is a default-flag — propose lifting the constraint into a pin, a preamble caveat, or the referenced design lock, or dropping it entirely if a measurable outcome already covers the behavior.

1. **Symbol naming.** ACs that name specific functions / files / hooks / components / types / props / events. → Move names to a "symbol names are illustrative" preamble; keep the *behavior* in the AC.
2. **File-count / decomposition mandates.** "Each piece per-file unit-tested", "separate component for each variant", "one module per X", "split into N files". → Restate as "each X is testable in isolation" or "each X has its own coverage target"; let the impl agent choose file count.
3. **Code-comment or documentation-placement mandates.** "Top-of-file comment citing X", "README entry per file", required PR-description sections, mandated JSDoc tags. → Restate as "the mapping from X to Y is reviewable in the PR"; let the impl agent choose the artifact location.
4. **Redundant restatement of design-lock content.** ACs that re-state in prose what a referenced mockup / spec section / ADR already binds (button labels, copy, exact ordering, pixel values). → Either drop the AC and let the fidelity target carry it, or lift the new information into the design lock instead of duplicating in the AC.
5. **Mandated mechanism without rationale.** "Must use library X", "must use `<details>` element", "must use a pure function" — where alternatives would meet the same behavior, with no reason given. → Either add the rationale (turning it into a legitimate pin) or restate as the behavior the mechanism provides.
6. **Pixel-precise visual specs outside the mockup.** "4 px accent rail", specific CSS values, exact spacing in ACs. → Drop; the mockup is the fidelity target.
7. **Upstream-contract restatement.** Specific REST paths, JSON field names, header shapes, or wire formats owned by an upstream ticket. → Reference the upstream ticket's contract or restate as the *behavior* the ticket consumes, not the wire format.
8. **Coverage / test-shape mandates beyond the project default.** "100% per-file coverage", "must be a Playwright test", "one test per branch" — when the project's standards already cover testing requirements. → Reference the standard instead of restating it; drop bespoke per-ticket raises unless the operator has a reason.

When you flag any of these, **also scan parallel ACs in the same ticket** for the same constraint shape. Inconsistent application (constraint in one AC, latitude in another) is a churn vector — flag both together and propose a uniform treatment.

#### Q3 — Pass/fail anchoring

Does every AC have a clear, reviewer-enforceable pass/fail signal? Flag both directions:

- **Under-anchored.** ACs whose pass condition depends on judgement the ticket hasn't tied to anything concrete — "good UX", "appropriate error handling", "reasonable performance", "follows the design language" without a referenced mockup / spec / metric. → Propose anchoring to a concrete reference (mockup, spec section, ADR, numeric threshold), restating as a measurable outcome (an assertion, a fixture, a count, an enumerated case list), or dropping the AC if it's vibes.
- **Over-anchored.** ACs whose pass/fail is bolted to a single specific artifact — a specific test file name, a specific log line, a specific commit message — where the underlying behavior could be measured many equivalent ways. → Restate as the behavior; let the impl agent pick the measurement. (This row overlaps with Q2; treat it as Q2 if the over-anchoring is structural.)

Under-anchored ACs typically need *more* specificity; over-anchored ACs need *less*. The skill's bias is toward measurable outcomes, not toward measuring instruments.

#### Q4 — Reviewer ↔ implementor tensions

Are there tensions in the ticket that will cause reviewer-implementor churn? Tensions look like: an AC that names a mechanism while another AC names an outcome that conflicts with that mechanism; ACs that mention non-goals; ACs whose pass/fail signal depends on judgement the ticket hasn't anchored. For each tension, **propose a rewording** that lets reviewers enforce the behavior/outcome while leaving the implementor space to react to technical issues that surface during build.

#### Q5 — Pin consistency

A *pin* is any sentence in the ticket that explicitly grants the impl agent latitude on a dimension — names, file count, mechanism, artifact location, etc. Pins are how a well-groomed ticket signals "the reviewer enforces behavior, not shape." But pins only work if they're applied **uniformly** across parallel ACs; a pin in one AC contradicted by a sibling AC is a churn vector worse than no pin at all.

Procedure:

1. **List every recognized pin in the ticket.** Quote the exact wording and note which AC or preamble it appears in. Common recognized shapes (the operator can add new ones, but record them in the same form so reviewers can apply them):
   - *"Symbol names are illustrative"* — names don't bind, behavior does.
   - *"File count is impl's call"* / *"five testable surfaces, not five files"* — decomposition doesn't bind, testable surfaces do.
   - *"Mechanism is impl's call"* — the specific approach doesn't bind, the outcome does.
   - *"Documented somewhere reviewable in the PR"* — artifact location doesn't bind, reviewability does.
   - *"X is the impl agent's choice"* — generic latitude grant.
2. **For each pin, scan every other AC in the ticket** for the constraint the pin granted latitude on. A pin saying "file count is impl's call" should not coexist with a sibling AC mandating "each piece per-file unit-tested."
3. **For each contradiction found**, propose one of:
   - (a) Adding the same pin to the sibling AC, applying the latitude uniformly (the default — under-constraining bias).
   - (b) Removing the pin from the original AC, applying the constraint uniformly (only when the operator confirms the constraint is genuinely load-bearing across every AC).

The reviewer's expectations must be uniform across parallel ACs. Mixed signals guarantee that whichever side the impl agent picks, *some* AC will flag it.

#### Q6 — Impasse risk

Is there anything that could lead to **impasse** (where reviewers keep returning the same finding and the implementor keeps re-arguing the same counter) that the operator should specify **now** to avoid the impasse? Common shapes: contested test-mocking boundaries, contested file/folder layouts, contested "this is in scope vs. this is the follow-up". For each one, propose the explicit sentence that pins it down.

### 4. Present the bundled edit

Once Q1–Q6 have been walked:

1. Apply every accepted edit to the in-memory body. Preserve everything else verbatim (whitespace, headings, link syntax). Do not "tidy up" content the operator didn't approve a change to.
2. Write the result to `.agent-loop/groom-proposed.md`.
3. Show the operator a diff between `.agent-loop/groom-baseline.md` and `.agent-loop/groom-proposed.md` — use `diff -u` (or `git diff --no-index`) and surface the output verbatim in the chat. If the diff is empty, tell the operator "no accepted edits — nothing to apply" and stop (cleanup section below still runs).
4. Run a final `AskUserQuestion`: "Apply these edits to issue #<n> on GitHub now?" with options: "Apply now (Recommended)" / "Cancel — leave the issue unchanged" / "Other".

### 5. Apply

If the operator chose Apply:

1. `gh issue edit <n> --body-file .agent-loop/groom-proposed.md` — apply to GitHub.
2. If the command succeeds **and** `.agent-loop/ticket.md` exists, overwrite it with the contents of `.agent-loop/groom-proposed.md` so the agent-loop's local copy matches the new GitHub body.
3. Print the issue URL and a one-line summary of which Qs produced accepted edits (e.g., "Applied edits from Q2, Q5. Q1, Q3, Q4, Q6 had no changes.").

If `gh issue edit` exits non-zero, surface stderr verbatim and stop. Do not retry.

### 6. Cleanup

At the end of the run — success, cancel, or error — delete `.agent-loop/groom-baseline.md`. Leave `.agent-loop/groom-proposed.md` in place on cancel (so the operator can inspect or re-run); delete it on a successful apply.

## Rules

- **Never paraphrase the ticket when proposing edits.** Quote the exact text being changed; show before/after.
- **Do not propose edits for things the operator didn't accept.** No silent "while I was in there" cleanups.
- **One concern per `AskUserQuestion`.** Do not bundle Q2 and Q3 into one prompt.
- **If an `AskUserQuestion` is cancelled**, stop immediately. Do not apply anything. Do the cleanup in section 6.
- **Do not modify any other ticket or PR.** This command edits exactly one issue body.
- **Do not run `agent-loop` mutating subcommands** (`approve`, `request-changes`, `impasse`) from within this command. Grooming is upstream of those gates.
- **Mermaid in any proposed diagrams** per the global mermaid rule — never ASCII art.
