# simple-plan-loop-v1 — work turn

Plan the linked ticket into the `plan` artifact, write its intent into the `groom-intent` artifact, polish the
plan, review it, and fix it until the review ends, deciding every question yourself as the brief says.

1. Read the issue with its comments and linked issues, and the code, spec and standards it touches. Read the
   repository's agent instructions (for example `CLAUDE.md`) for the commands it runs its tests and build with.
2. Write the `groom-intent` artifact, as **The intent** in the brief says.
3. Draft the plan with the sections under **The plan** below.
4. Polish the draft with the plan-polish method under **Polishing the plan** below.
5. Review the plan with the reviewers below, then fix or dismiss every finding, logging each in
   `## Review history` and each decision a fix needs in `## Planner decisions`. When a fix changes the plan's
   approach, run the method's passes again over what it changed. The first pass runs every reviewer. A later pass
   runs only the reviewers whose findings you fixed and any whose area your fixes touched, and every
   reviewer again only when a fix changes the plan's acceptance criteria, scope, approach, increments or fit
   verdict.
6. Repeat step 5 until the review ends, as the review rules in these instructions say.

# The plan

## Fit

First in the plan, so the operator reads it before anything else:

```
## Fit

Light-path fit: yes | no
- No RED/GREEN dependency: holds | fails — <evidence>
- Estimated size: <n> lines (production <p>, test <t>) — holds | fails
- No new test infrastructure: holds | fails — <evidence>
- Not an epic: holds | fails — <evidence>
```

Apply the rules under **The fit check** in the brief. When the verdict is `no`, add one line saying what
`feature-dev-v3` would do differently for this ticket (for example "two slices, each reviewed on its own").

## Scrutiny flags

Under `## Scrutiny flags`, the items the brief's **Scrutiny flags** describes, or `None.`

## Research

Only when the shape is not obvious, as the brief's **Research first** says: the decisions, the tradeoffs and
the recommendation. Omit the section otherwise.

## Test plan

Map every acceptance criterion to an observable-behavior test at the right layer (unit / integration /
e2e), in RED-first order, with injection seams named for the domain concept the unit needs. Schedule every edit
to or deletion of an existing test the change needs as part of an increment's RED, so the edited test is seen
failing before the code it covers.

## Technical plan

The smallest correct design that satisfies the ticket — the files, seams, and contracts it touches, and
the shared definitions it single-sources.

Under an `Assumptions` heading, list each behaviour the plan relies on that
no test environment in the repository exercises — the developer's host OS when the tests run elsewhere, a
real external tool the tests replace with a stand-in — and the real-run check that verifies it.

## Increments

Under `## Increments`, one `### Increment <n> — <title>` entry per RED/GREEN cycle, in dependency order, each
with an `Acceptance criteria:` line naming the criteria it delivers and the tests whose failure is its RED.
Every acceptance criterion lands in exactly one increment.

## Complexity drivers

Once the plan is drafted, find the acceptance criteria that drive most of its cost: a criterion that takes a
disproportionate share of the design or the tests; that brings in a new external system, component or state;
or whose failure paths need decisions the ticket does not settle. Under a `## Complexity drivers` heading, name
each such criterion, what it costs the plan, and one or more simpler alternatives — a narrower criterion, a
different mechanism, or a split into a follow-up ticket — with what each alternative saves and loses, and your
recommendation. Propose only: never apply an alternative yourself; the report's `## Needs your call` lists each
driver. When no criterion stands out, write `None.` under the heading.

# Polishing the plan

Polish your draft in place with the plan-polish method below, included verbatim. Inside this step, these rules
take precedence over anything the method says:

- **Bindings.** The plan artifact is this step's `plan` output; the ticket is the linked ticket. Ignore the
  method's default paths, branch patterns and marker strings — the turn instruction gives this step's completion
  marker.
- **Report in the plan and in the report.** Write the method's five-part report as a `## Polish report` section
  at the end of the plan, above the completion marker, replacing any earlier one but carrying over every
  recorded operator decision. What it leaves for the operator also goes in `plan-report.md` (see "The report").
  Never stop to ask a question.
- **Re-review is yours.** Your own review passes re-check the polished plan, so "Re-review?" informs them; it
  does not need to request anything.
- **The plan's own tokens.** Keep `## Fit`, `Light-path fit:`, `## Scrutiny flags`, `## Increments`,
  `### Increment` and `Acceptance criteria:` exactly as written: the next steps look for them by name.

---

# Plan Polish — harden an implementation plan against its ticket

Purpose: take a drafted/consolidated implementation plan and make it *robust to the implementer* — so the
implementer can pick any justifiable path and reviewers litigate **outcomes, not implementation choices**.
This is a hardening pass, not a re-plan. Run it independently, in any repo.

**Default posture: act, then report — this pass runs completely independently.** Almost everything it does is
intent-preserving — it clarifies, tightens, references, and adds verified facts without changing what the plan
achieves. Do those silently. The narrow set of changes that *would* be a goal-level tradeoff or a large-effort
rework, you do **not** apply and do **not** stop to ask about — you leave the plan intent-preserving and
surface each as a **recommendation** in the report. **Never raise `AskUserQuestion`; the report is where every
decision surfaces.**

## Repo bindings — resolve these first
The methodology is repo-agnostic; only these anchors vary. Resolve them for the repo you're in (defaults are
for the **agent-terminal plan-loop**; adapt for others):
- **Plan artifact** — the file to polish. Default `.agent-terminal/loop/artifacts/plan.md`. Otherwise the
  plan file the user names, or the most recent plan under the repo's plans directory.
- **Ticket source** — the GitHub issue number, from the branch (default pattern `plan-loop/issue-<N>`), the
  plan's title, or a `closes #<N>`. If ambiguous, pick the best-supported candidate, proceed, and name the
  assumption in the report; if none is discoverable, harden against the plan's own stated goals and say so.
- **Standards corpus** — the repo's own convention/standards files, read so passes 5–6 reference instead of
  re-derive. Default: `CLAUDE.md`, `CODE-STANDARDS.md`, `TICKET-STANDARDS.md`, `TRACER-BULLET.md`, and any
  spec the plan cites. In another repo, use whatever `CLAUDE.md`/CONTRIBUTING/docs it has.
- **Plan turn/completion marker** — a trailing sentinel the loop relies on that must stay the last line, if
  the repo uses one. Default `<!-- agent-terminal:work-turn-complete:plan -->`. If the plan has no such
  marker, skip that invariant.

## Setup (do this first, every run)
1. Resolve the **repo bindings** above.
2. **Read the ticket from source — body AND comments — never the plan's paraphrase of it.**
   `gh issue view <N> --json number,title,body,labels,comments`. The body is the intent contract and the
   comments are part of it (they get bundled verbatim into the work/review context). Half the tensions this
   pass finds live in the gap between what the ticket says and what the plan restates.
3. **Read the standards corpus** so passes 5–6 reference instead of re-derive.
4. **Note the plan's structure to preserve it** — keep any turn/completion marker as the last line, and keep
   section numbering stable so file:line and cross-refs elsewhere don't rot.

## The decision rule — DO vs RECOMMEND (read before touching anything)

**DO autonomously (intent-preserving hardening — apply, then report):**
- Convert overspecified mechanism (exact strings, identifiers, control-flow shape, `file:line`) into
  *binding contract + illustrative example*; add a "binding vs illustrative" note.
- Pin ambiguous vocabulary to one meaning; bind acceptance to observable outcomes; declare genuinely
  unobservable details (check order, seeding steps, message wording) non-litigable.
- Make ticket **driftables** explicitly backward-looking (never touch the ticket's *requirements*).
- Add terse **references** to standards the plan already leans on (pointer + failure-mode hint, no re-explain).
- Add **code-verified** context the implementer needs (only after verifying — see pass 6).
- Fix a **small, clear correctness defect** the pass uncovers (e.g. a test recipe that wouldn't reproduce the
  bug), and flag that a re-review is warranted.
- Remove belt-and-suspenders that provably guards nothing.

**RECOMMEND (do NOT apply, do NOT ask — leave the plan intact and surface it in the report) when a change is:**
- **A real tradeoff against, or change to, the ticket's goals.** Anything that would edit a Scope / Acceptance /
  Non-goal *requirement*; drop or swap a design the ticket endorsed; or resolve an ambiguity the ticket left
  open in a way that changes what "done" means — especially a product/UX decision (e.g. "block loudly at the
  gate" vs "suppress the affordance upstream" when the ticket sanctioned either). Do **not** bake the decision
  in yourself; write it in the report as a crisp tradeoff with a recommended option, so the operator can decide
  and a follow-up run (or the operator) lands it.
- **An important but large-effort rework.** A fix that meaningfully widens the change's surface — threading a
  new dependency through a layer, a broader refactor, a whole new test-infra module. The effort/scope call is
  the operator's; surface it in the report with the cost and your recommendation, don't silently undertake it.

Everything else: just do it. Do **not** ask permission for hardening, and **never raise `AskUserQuestion`** —
collect every recommend-item and put them all in the report's "Needs your call" section.

## The six passes

### 1. Proportion — is the plan doing more than the problem needs?
Separate **essential** complexity (forced by a real constraint — e.g. a three-way result forced by an
audit-fires-iff-a-preview-was-shown rule) from **incidental** complexity and **house-style tax** (mandated
TDD/tracer-bullet ceremony is not over-engineering). Report the proportion read plainly. Autonomously cut only
vacuous guards. **Do not** remove anything load-bearing or change the core design — leave it and **recommend**
it in the report; that's a goal-level call, not hardening.

Then audit everything the plan builds beyond the direct path to its acceptance criteria, and the tests that pin
it: abstractions and extension points, configuration and options, generality for cases the ticket does not
have, new modules, persisted formats and states, fallback, retry and recovery paths, caching and optimisation,
and every guard, validation, fail-closed path and hardening rule. This is where plans escalate unnoticed: each
step of the reasoning sounds right, and the sum is a design or a threat model nobody asked for.
- **Source every addition.** For each item, cite the acceptance criterion, the ticket rule, or the specific
  spec or standards clause that requires it *for this change*. An item justified by a general principle,
  a likely future need, symmetry with other code, or "while we're here" rather than a stated requirement is
  a **scope escalation**.
- **Prefer the simpler shape.** For each sourced item, ask whether a materially simpler mechanism meets the
  same requirement — a constant instead of an option, a function instead of a framework, one state instead of
  several, reusing an existing module instead of adding one. Where one does and swapping is more than a local
  edit, list it as a scope escalation naming the simpler alternative.
- **Name the adversary.** For defensive items, state in one line who or what the plan treats as hostile, and
  what that party can write or control. Source it to the ticket or to a trust model the repo's spec or
  standards state. A party the plan defends against that neither names is a scope escalation, however
  reasonable the inference that got there ("this file is writable by X, so treat it as forged").
- **Review history is evidence, not authority.** An item that earlier review rounds asked for is not thereby
  required; source it like any other.

Do not cut a scope escalation yourself — whether it is in scope is the operator's call. List each one in the
report with what it adds (or the threat it assumes), why no requirement sources it, the simpler alternative if
there is one, and its rough size in plan lines.

### 2. Overspecification — churn-proof the specifics
Find where the plan says "do it exactly this way" but a justifiable alternative exists: exact log/error
strings, identifier names, `switch`-vs-`if`, exact test-fake shapes, and `file:line` anchors. Each is a churn
magnet — the implementer makes a defensible different choice and it reads as a plan violation.
- Fix: state the **binding contract** (the properties that must hold) and demote the concrete choice to
  *illustrative*; anchor comment/site references by the **named symbol**, treating `file:line` as navigational.
- **Preserve** genuinely binding specifics: a keyword an existing test matches, a security invariant, an
  audit/classifier property, a shared-semantics single-source. Loosening those is a bug, not hardening.
This pass is pure hardening → autonomous.

### 3. Ticket↔plan tensions — make reviewers litigate outcomes, not mechanism
Find where a reviewer and the implementer could argue *implementation* because the ticket/plan conflate an
outcome with a mechanism, or use one word for two things.
- Fix: pin the vocabulary; restate acceptance as the observable outcomes the ticket's ACs actually test;
  declare non-outcome details (which check fires first, how a fixture is seeded) explicitly non-litigable;
  and note where a choice is **ticket-endorsed** so a settled debate can't reopen.
- **Recommend (don't apply)** when resolving the tension embeds a goal decision (see the decision rule). The
  word-disambiguation and outcome-binding are autonomous; the underlying product call goes to the report.

### 4. Ticket driftables — statements the implementation makes false
Read the ticket body + comments for **present-tense descriptions of today's code** that the fix will falsify:
"X is checked only at …", "the TODO exists", an exact quoted current code line, "silently falls through".
A reviewer diffing the ticket against post-fix code will flag these.
- Fix: frame them explicitly backward-looking — a single "this section describes pre-change behavior" note
  covers a whole problem-statement section; backdate isolated facts ("as of this writing … ; this change
  removes it"). **Never** alter Scope / Acceptance / Non-goal requirements — those are outcomes and must stay.
- Editing the ticket is autonomous for backdating; see **Editing the ticket safely** below.

### 5. Surface existing standards — reference, don't duplicate
Find the landmines specific to *this* change whose governing standard the plan uses implicitly. Add a terse
**reference** (a pointer to the standard + a one-line "here's how it bites" only where the failure mode is
non-obvious). Never restate the standard's content. Typical catches: a best-effort side effect that must not
throw on the critical path; test assertions that target a domain injection seam (so they aren't "testing
mocks"); an e2e that boots its own app and must be tagged accordingly; a spec-authority/changelog gate for a
behavior change. → autonomous.

### 6. Create missing context — but VERIFY against the code first
Find gaps where the implementer needs a fact the corpus doesn't provide (a store/function's exact contract, a
fixture recipe, whether a test helper already exists).
- **Verify before you write. Never speculate.** Spawn a read-only agent (`Explore`) to establish the facts
  from the actual code with `file:line` evidence, then act on what it finds:
  - **Confirmed correct** → pin the fact so the implementer wires it right and no reviewer demands needless
    defense.
  - **Latent defect uncovered** → fix it if small (and flag re-review); **recommend (don't apply)** if the fix
    is large-effort or changes the plan's approach.
  - **Missing infrastructure** → flag it explicitly so it isn't discovered late; if building it is large,
    recommend it in the report rather than undertaking it.
- **Do not invent a new *standard*** when an existing one already governs the concern — redundant standards
  are a smell. The gap is almost always project-specific *context*, which belongs in the plan.

## Invariants you must not break
- Keep the plan's turn/completion marker (if any) as the last line; keep section numbers stable.
- Never loosen a specific that is genuinely binding (test-anchored keyword, security default, audit-iff,
  shared-semantics single-source). When unsure whether a specific binds, treat it as binding and leave it.
- Verify (pass 6) before creating any "fact". A wrong "verified" fact is worse than an omission.
- Keep every edit intent-preserving unless it is an explicit correctness fix — and say which it was.

## Editing the ticket safely
- Body: fetch raw (`gh issue view <N> --json body -q .body > file`), edit the file, push with
  `gh issue edit <N> --body-file file`. Preserve any groom/turn markers.
- A specific comment authored by you: `gh issue comment <N> --edit-last --body-file file` — but first confirm
  `gh api user -q .login` equals the comment's author and that it IS the last comment. If not, don't guess.
- Backdating driftables is autonomous. Editing a **requirement** (Scope/Acceptance/Non-goal) is a goal change —
  do **not** do it; recommend it in the report instead.

## Output / reporting
Report in five parts, in this order:
1. **Proportion** — the report's first line is exactly one of `Proportion: proportionate`, `Proportion: heavy`
   or `Proportion: overbuilt`. Follow it with the plan's size against the ticket's acceptance criteria and the
   three largest contributors to that size.
2. **Polished autonomously** — the hardening applied, grouped by pass, one line each with the *why*.
3. **Scope escalations** — each unsourced addition, simpler alternative, or unnamed adversary from pass 1:
   what it adds or defends against, why no requirement sources it, its rough size, and your recommendation. Write "None" when there are none.
4. **Needs your call** — each recommend-item (goal-level tradeoff or large-effort rework) you deliberately did
   **not** apply, as a crisp tradeoff with a recommended option, so the operator (or a follow-up run) can land
   it. This is the whole set — the pass never asks mid-run, so nothing is lost if it isn't here.
5. **Re-review?** — "No" if every edit was intent-preserving; "Yes" and why if a correctness/approach change
   landed (e.g. a corrected test recipe), so the loop can re-confirm the plan is clean.

## Anti-patterns (don't)
- Reviewing the plan's *paraphrase* of the ticket instead of the ticket itself (body + comments from `gh`).
- Loosening a binding specific in the name of "churn-proofing".
- Writing a "verified" fact you didn't verify against the code.
- Inventing a new standard when an existing one already applies.
- Stopping to ask permission (or raising `AskUserQuestion`) instead of acting on hardening and reporting.
- Treating an addition — a defence, abstraction, option or generalisation — as needed because a general
  principle implies it, a future need seems likely, or a past review asked for it; source it to this change's
  requirements, or list it as a scope escalation.
- Silently *applying* a goal-level or large-effort change that was the operator's to decide — recommend it in
  the report, don't bake it in.
- Disturbing the completion marker or renumbering sections.
