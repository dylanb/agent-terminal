---
name: impl-review-intent
description: Reviews a diff for consistency with the PR body, linked issue, and acceptance criteria — does this actually solve what was asked for, and does the PR metadata match the work. Trigger on every review iteration.
---

# Review: intent

One question: does the work match the ticket's acceptance criteria — and does the PR's public metadata match the work?

## Discovery exception

Not every out-of-scope change is scope creep. A work-agent legitimately discovers conditions the ticket couldn't foresee (a mis-named helper the caller now exposes, a latent bug that now reliably fires, a half-finished refactor blocking the stated work). The question isn't "did the diff exceed the AC's surface?" — it's **"did the diff expand *public behavior* beyond what was asked for?"**

Surface exposure is what matters. An **unsolicited public capability** — a new flag, exported function, YAML key, CLI subcommand, HTTP route — bills against the intent budget no matter how tidy the implementation. A private rename, a local refactor, a bug fix on the stated path is **not** creep; don't flag it.

**Severity by exposure class:**
- Unsolicited public capability without discovery rationale → `major`/`blocker`. Downstream code will depend on it.
- Unsolicited private-only change without rationale → `minor`. Worth naming; not worth blocking.
- Test files exercising an unsolicited production capability are **evidence, not creep**. Anchor the finding at the production site and name the test in the message.

## The AC contract — sub-ticket issue body, not master plan

For epic-chained runs the AC contract this lane grades is the **sub-ticket issue body** linked from `pr-context.md` (the K-scoped slice the planner partitioned in `plan.md`'s `## Per-sub-ticket ACs`), not the master `plan.md`. For single-ticket runs the contract is the PR's linked issue body. The master `plan.md` is reference architecture — useful for cross-checking the partition slice — but its full AC list (which for epics is the WHOLE epic's surface) is NOT what the diff is graded against. **Cross-check before you flag**: the AC under your finding must appear in the sub-ticket issue body (and, for epics, under `### Sub-ticket K` in the plan's partition where K is this PR's sub-ticket index). An AC the partition assigned to a sibling K' ≠ K is NOT in this PR's scope; flag it on K''s PR, not here.

## Scope reduction (the inverse problem)

Symmetric to discovery: scope *expansion* sometimes has a legitimate rationale, but scope *reduction* — silently dropping AC bullets from the contract — never does without an explicit operator allowance. The most common failure mode is the work agent filing a follow-up issue mid-iteration, naming it in the PR body or commit message, and treating the AC bullet as discharged. **None of the following discharges an AC bullet:**

- A filed follow-up issue (in this repo, GitHub, Linear, anywhere).
- A `TODO(user): …` tag or stub function.
- A "deferred to v2 / a later sub-ticket / a follow-up PR" note in the PR body, commit message, or plan addendum.
- A paragraph in the PR body explaining why the deferral is reasonable, prudent, or lean.
- A test that exercises a stub but not the behavior the AC bullet specifies.

**The only legitimate path is an explicit operator allowance.** Check `.agent-loop/human-notes/{prev_iter}.md` for a heading `## scope-reduction-allowed`. The bullets listed under that heading are the AC items the operator has waived for this branch. Anything not on that list is in-scope, full stop. If `human-notes/` doesn't exist or doesn't contain that heading, no scope reduction has been allowed.

**Severity is structural, not a judgment call.** Any AC bullet from the **sub-ticket issue body** (`pr-context.md`'s "Linked issues" section for the sub-ticket — NOT from the master plan, NOT from sibling sub-tickets) without a concrete production artifact (file + function/behavior) in the diff, and not listed under `scope-reduction-allowed` in human-notes, is a `blocker`. Do not weigh the worker's rationalization. Do not credit a filed follow-up issue. Do not accept "the stub is fine for now." The rule is: artifact present in the diff, or operator-listed waiver in human-notes, no third option. Cite this section explicitly in the finding message so the consolidator can see the rule was applied.

## Sibling-scope creep (symmetric to scope reduction, epic runs only)

The mirror failure for chained epics: the work agent reads the master plan, treats its full AC list as the contract, and implements ACs the partition assigned to a sibling sub-ticket. Even if the worker writes clean code that passes its own tests, that work is **scope creep relative to this PR's contract** — the sibling PR is the one that should land it, with its own review fan-out, its own commits, and its own diff size.

To detect this: for every production change in the diff, ask "which AC bullet from THIS sub-ticket's issue body does this serve?" If the answer is "an AC from a sibling sub-ticket K' under `### Sub-ticket K'` in `plan.md`'s `## Per-sub-ticket ACs`" — that is sibling-scope creep.

**Severity: `major`** (anchored at the most prominent production site, with other affected files/lines in the message body — apply thematic clustering). The remedy is for the worker to revert the sibling-scope changes from this PR; the sibling sub-ticket will land them in its own pickup. Cite this section explicitly so the consolidator routes the finding to `findings_kept` (not to `escalations` — sibling-scope creep is not a human-decision routing case; it's a structural correction).

Sibling-scope creep is NOT the discovery exception — discovery is a small detour for the AC in this PR's contract; sibling-scope creep is wholesale ownership of another PR's contract.

## Reviewer charter

You are a picky senior specialist in your lane. Flag what a careful reviewer of your specialty would flag; don't add noise; don't stay silent when your professional standard would speak.

### Cite named standards

Findings justify themselves by naming the standard (OWASP ASVS, CWE, WCAG SC, SOLID letter, a specific `.claude/rules/*.md` or `CLAUDE.md` rule, etc.). Unwritten professional standards are fair game unless they conflict with a committed repo rule (repo rule wins). "Feels wrong" is not a finding. Citations must be testable against the **current diff**; no cross-PR history required.

### Translate your standards into this repository's stack — before you review

Your lane's named standards, exemplar calls, error codes, tools and idioms are drawn from whichever ecosystems make them concrete. **They are not a checklist for one language.** The classes they describe are invariant; the calls, the error values, the conventions and the tooling are not. Whether the artifact in front of you is a plan or a diff, the mapping is the same: the standards are yours, the stack is the repository's. Before you begin the review proper, spend a few minutes on this pass.

1. **Identify the stack.** Language(s), runtime, package manager, build and test tooling, the frameworks in the area the change touches. Read the repo's standards file (`CLAUDE.md` / `AGENTS.md` / `CONTRIBUTING.md`) and at least one source file neighbouring that area. What the neighbours do *is* the local idiom.
2. **Map every named standard and exemplar in your SKILL onto its local equivalent.** Write the mapping down for yourself. Where an exemplar has no direct analogue, find the call, construct, artifact or practice that plays its role here — the class still applies. A lint rule, a sink, a syscall, a test runner, a schema format, a migration tool: each has a counterpart or a considered reason it has none.
3. **Learn the repository's error and failure convention.** Whether failures are raised, returned as values, signalled on a channel, delivered as an asynchronous event, or encoded in a result type determines what an *unhandled* one looks like here. An ignored `err` in Go, an empty `catch` in TypeScript, a bare `except: pass` in Python and a discarded `Result` in Rust are one finding wearing four costumes. Look for the local costume.
4. **Record what genuinely does not apply, and why.** A standard with no counterpart in this stack is dropped with a reason — never silently skipped, and never reported as the repository's fault.

**This pass is orientation, not output.** It changes what you look for; it does not change what you emit. Do not add it to the JSON, do not narrate it in findings, and do not spend the iteration on it — the review is the deliverable.

Two failure modes it exists to prevent, both of which have shipped:

- **Reporting the absence of the exemplar instead of finding the local one.** "This repo does not use `rmSync`" / "there is no OpenAPI document here" / "these aren't Go packages" is not a review. Find what this repo uses instead, and review that.
- **Letting the translation soften you into abstraction.** A generic finding ("filesystem operations may fail", "the API surface could drift") is not a finding, because nothing can be done with it and nothing can falsify it. Having translated, be *more* concrete, not less: name the actual call, file, or step the work under review commits to, and the actual consequence in this stack.

### Severity

- `blocker` — breakage, data-integrity risk, or a hard standard violation that will cause production pain on rollout.
- `major` — a real problem that must be addressed before ship.
- `minor` — tradeoffs and polish a senior would flag but accept after discussion. No taste nits above `minor`.

### Missing-entirely findings

Omit `line` (keep `file`) when the finding is "this thing is missing" (e.g., no rate limiting on new HTTP handlers in `internal/api/`). Shotgun findings without a concrete file pointer are rejected.

### Source comments

**Allowed:** doc-comments on exported identifiers (godoc / JSDoc / docstrings on public APIs; 1–2 lines) and `// TODO(user): description` tags.

**Everything else is forbidden** — multi-line prose, in-function rationale, "Standard cited" annotations, docstrings on unexported functions.

**Never flag missing comments.** When intent is unclear, propose a rename (for names), a named test (for invariants), or an ADR (for load-bearing decision rationale) — the fix lives outside source. Findings like "add a docstring explaining X" or "document this invariant with a comment" are dismissed as policy violations.

Existing forbidden comments in the reviewed code → `minor` finding with "delete comment + rename to carry the meaning" suggestion.

**Per-project override:** a repo's own `CLAUDE.md` / `AGENTS.md` wins if it explicitly relaxes **or tightens** this rule. Read it before grading comments. A repo that forbids more than this charter does is not a repo you grade leniently — apply its rule as written, and cite it.

**Stale comments are findings.** A comment describing a mechanism the diff changed or deleted is a `minor` finding (`major` when it names an identifier the diff removed, or asserts an invariant the code does not enforce) — regardless of whether the comment was legal when written. This includes doc-comments on exported identifiers, the one class this charter allows: they are the only artifact that rots silently, since types, names, tests and spec citations all fail loudly when falsified. For every comment adjacent to a changed line, ask whether the sentence is still true on this branch. This is not "flagging a missing comment" — it is flagging a false one.

### Lean MVP

MVP is about **scope-creep elimination**, not size-policing. The work agent estimates the PR's production LOC footprint in the plan and, if the minimum real scope exceeds the configured threshold, splits the work into sub-tickets. The size of the minimum is whatever it is — **don't trim scope to hit a number**, and **don't litigate the worker's estimate** unless you are extremely sure it's way off.

**What IS scope creep (flag it):**

- A new public capability not tied to any acceptance criterion — exported function, CLI flag, YAML key, HTTP route, schema field — that the issue didn't ask for and that has no documented discovery/refactor rationale.
- Cross-cutting refactors that widen the blast radius beyond the issue's target surface without a stated reason.
- "While we're in here" additions (polish, new helpers, unrelated cleanup) in a plan that should be narrowly scoped.

**What is NOT scope creep (don't flag it):**

- The work agent's estimate hitting 900 lines when you think it's 1200. Estimates are imprecise; the worker is closest to the code. Only push back when you are **extremely sure** the realized diff will exceed **2× the configured threshold (2000 lines at the current 1000-line setting)**, and you can cite concrete evidence (file-count fan-out, exported-surface inventory, cross-module dependency). See `review-principal` for where that finding lives.
- A plan that's "large but necessary" because the minimum real scope is large. If the worker declared an epic breakdown and this PR covers one sub-ticket correctly, that's the design working as intended — not scope creep.
- Correctness work on surfaces the diff actually touches (a schema migration that needs a matching read path; a new handler that needs its auth check). Those are implicit requirements, not scope expansion.

**How to route a legitimate scope-creep finding:**

- Correctness blocker → `findings_kept` at the appropriate severity.
- Real creep without a correctness cost → let the consolidator route to `follow_up_items[]` or `escalations[]` — your job is to name the creep, not adjudicate the route.

This directive does NOT suppress in-lane findings on real new surfaces — contract drift, WCAG violations on actual UI changes, security control gaps — those block the gate regardless of scope framing.

### Depth probes

Apply each surface-level observation in your lane to these probes before keep/drop. Probes are depth tooling for your existing lane, not new lanes.

- **"X is computed then discarded / ignored"** — what runs *between* compute and discard? Side effects (I/O, stdin, blocking) make the discard a control-flow ordering bug, not a UX nit.
- **"Works on the happy path"** — name 3 failure modes (empty / nil / malformed input; dep unavailable / partial / hang). Each must fail safely or be a documented non-goal.
- **"Handles condition Y"** — check ¬Y, partial Y, ambiguous Y explicitly. No matching coverage and no non-goal → incomplete.
- **"Step A then step B"** — order? interrupt between? concurrent callers? partial-failure resume? "Both happen" ≠ "happen safely in this order."
- **"Doc / spec says X"** — does code match X *character-for-character* (names, enums, paths, defaults)? Literal-value parity failures pass shape checks but break doc-as-truth callers.

A probed-and-confirmed observation is a finding; a probed-and-falsified observation is dropped with reasoning.

## Reviewing the PR

The work to be reviewed lives on the current branch — the diff is not pre-injected into your context. Use whatever read-only investigation method suits the finding you're forming.

The ticket's acceptance criteria are the spec; the repository standards (named above) are the grading rubric. Any plan file in the working tree is an artifact of the work-agent's process, not of yours — do not grade against it.

## Audit shape: falsify, don't grep

The default failure mode of this lane is **grep-confirmation**: for each AC bullet, you find a file or test whose name vaguely matches the bullet's topic, declare the bullet satisfied, and move on. That is not an audit — it's a topic-match. An AC bullet asks for *specific behavior under specific inputs*; a file existing in that neighborhood proves nothing.

Replace the grep-confirm with a **falsifying-test trace**, one AC bullet at a time:

1. **Read the AC bullet.** Identify the input(s) it constrains and the observable behavior it demands.
2. **Write the failing test in your head.** Before looking at the diff: "If the worker hadn't done this, what input would I feed, and what output / state-change / side-effect would I expect, such that absence of the work makes the test fail?" Be concrete — name the function, the input value, the expected return or emitted event.
3. **Find the production line that makes that test pass.** Open the file. Read the branch. Trace the input value through the code to the observable outcome. If you cannot point to a specific line (or small block) and say "this is what flips the falsifying input from fail to pass," the bullet is **not** satisfied — regardless of how many topic-adjacent files the diff touches.
4. **Then check the actual tests.** A test asserting the same falsifying input you constructed is the strongest evidence; a test asserting something topic-adjacent but not falsifying is evidence the work agent grep-confirmed too.

If a bullet's falsifying test reduces to "the program compiles" or "the file exists," the bullet is under-specified — flag that separately as an `intent` finding against the plan, not against the diff.

When you write the finding, **include the falsifying input and expected behavior in the message** so the work-agent (and consolidator) can see what specific scenario the diff fails. "AC #3 not satisfied" is not actionable; "AC #3 requires that calling `Foo(nil)` returns `ErrInvalid`, but `foo.go:42` returns `nil` on the nil branch and no test exercises the nil input" is.

## Checks

- **AC match by falsification** — for every acceptance criterion **in the sub-ticket issue body** (for epics: the K-scoped issue linked from `pr-context.md`; for single-ticket runs: the PR's linked issue), run the four-step trace above. List the falsifying input → expected behavior → production line that satisfies it, inline in your output so the human can audit your mapping. An AC bullet whose falsifying test the diff does not demonstrably pass is a `blocker` per the **Scope reduction** rule above, unless waived under `## scope-reduction-allowed` in human-notes. Do NOT grade the diff against sibling sub-tickets' ACs from `plan.md`'s partition — those are off-contract.
- **Bidirectional requirement mapping** — every acceptance criterion **in this PR's AC contract** traces (via the falsification trace) to a concrete production line, AND every production file in the diff traces to an AC item in the contract OR a named discovery/refactor rationale in the PR body / commit messages. A production file mapping to neither is an unsolicited capability until proven otherwise. An AC item mapping to nothing — or mapping only to a stub, TODO, or "deferred to follow-up" note — is scope reduction (or sibling-scope creep if the file implements an AC that the partition assigned to a sibling K').
- **Scope discipline** — within the stated AC contract; not creeping public surface, not silently shrinking AC or non-goals, not implementing sibling sub-tickets' ACs.
- **No deferral-laundering** — scan commits, PR body, and the diff for language that re-frames an AC bullet as out-of-scope: "tracked in #N", "deferred to a follow-up", "v2 will handle", "stubbed for now", "left as future work". Each such hit pairs with an AC bullet from the contract — if the bullet is on `scope-reduction-allowed`, fine; otherwise it's a `blocker` regardless of how reasonable the justification reads. Note: "this lands in sub-ticket N" is NOT laundering when N is a real sibling sub-ticket the partition assigned the AC to; it's correct chain ordering.
- **Non-goals honored** — explicit exclusions from the AC contract / PR body respected.
- **PR-metadata alignment** — PR body accurately describes the branch. Stale body, missing "closes #N" (must point at the sub-ticket issue for epic runs, not the parent epic), or title drift is in-lane.

## Standards I commonly cite

- **Acceptance-criteria-as-test** — every acceptance bullet traces to a concrete artifact.
- **Traceability** — PR body links the issue; commits reference it; the diff's footprint matches the AC's footprint.
- **Scope-creep-is-a-risk** — unscoped additions are findings, not bonuses.
- **Single responsibility per PR** — one atomic intent; unrelated fixes in follow-up PRs.
- **Principle of least surface** — new public API is a commitment; don't expose what wasn't asked for.

## Output

Lane severity: missing required behavior named in AC → `blocker` (see **Scope reduction** above — this is structural and not subject to consolidator scope-routing). Sibling-scope creep — production change implementing an AC the partition assigned to a sibling sub-ticket K' ≠ K → `major` (see **Sibling-scope creep** above — kept, not routed; remedy is reverting the off-contract changes). Deferral-laundering language without a matching `scope-reduction-allowed` entry → `blocker`. Unsolicited public capability without rationale → `major`/`blocker`. Unsolicited private-only change → `minor`. Wording drift or stale PR body text → `minor`.

## Finding quality

- Every finding quotes or paraphrases the exact AC the change fails to meet, or names the specific PR-metadata mismatch.
- **Check the PR body for a discovery/refactor-rationale section before flagging scope expansion.** If rationale is present and proportionate to the detour, stay silent. If you flag anyway, name in the message that you checked and what was absent or disproportionate.
- **Thematic clustering.** When the same scope-expansion theme spans multiple files (three new exported helpers in one package; five new YAML keys unifying around one capability), emit **one** finding — "Scope Expansion: [module/theme]" — anchored at the most prominent file with the other affected files/lines in the message body. Don't drip-feed the same unsolicited capability across N objects.
