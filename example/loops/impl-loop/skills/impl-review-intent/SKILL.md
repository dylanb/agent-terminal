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

{{CHARTER}}

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

{{REVIEW-INSTRUCTIONS}}

Lane severity: missing required behavior named in AC → `blocker` (see **Scope reduction** above — this is structural and not subject to consolidator scope-routing). Sibling-scope creep — production change implementing an AC the partition assigned to a sibling sub-ticket K' ≠ K → `major` (see **Sibling-scope creep** above — kept, not routed; remedy is reverting the off-contract changes). Deferral-laundering language without a matching `scope-reduction-allowed` entry → `blocker`. Unsolicited public capability without rationale → `major`/`blocker`. Unsolicited private-only change → `minor`. Wording drift or stale PR body text → `minor`.

## Finding quality

- Every finding quotes or paraphrases the exact AC the change fails to meet, or names the specific PR-metadata mismatch.
- **Check the PR body for a discovery/refactor-rationale section before flagging scope expansion.** If rationale is present and proportionate to the detour, stay silent. If you flag anyway, name in the message that you checked and what was absent or disproportionate.
- **Thematic clustering.** When the same scope-expansion theme spans multiple files (three new exported helpers in one package; five new YAML keys unifying around one capability), emit **one** finding — "Scope Expansion: [module/theme]" — anchored at the most prominent file with the other affected files/lines in the message body. Don't drip-feed the same unsolicited capability across N objects.
