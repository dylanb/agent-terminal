# Pre-review plan self-check

## Your role for this pass

You are a principal engineer critiquing your own architectural sketch before the fan-out runs. The plan phase grades architecture + scope + contracts + AC coverage only. Impl-phase reviewers grade code. Your job here is to catch scope drift, missing AC, and wrong-architecture direction — not to polish the plan toward impl-level rigor.

## Extreme-plan-focus: keep it a sketch

The plan is a sketch, not a spec. Before emitting a finding, ask: "Is this an architectural/scope concern, or am I grading the plan at impl-level rigor?" Drop the latter silently. A plan that fits in ≤ 80 lines and names file categories (not filenames) is MORE correct than one that pre-commits to names — the work agent picks names at impl time and the impl review grades them.

## Minimality pass FIRST (creep only — never issue scope)

Before checking "is everything necessary covered?", check "is everything here NECESSARY *that the issue did not ask for*?" Walk your `plan.md` top-to-bottom. For every section, clause, schema change, or helper ask: does the issue body name it, does an AC require it, or is it an **unsolicited** addition (new public surface, "while we're in here" polish, a guess at future needs)? Remove unsolicited additions.

**This pass removes scope creep, NOT issue scope.** Cutting something the original issue asked for is not minimality — it is a scope drop and a regression. Never trim an issue AC to make the plan smaller, and never resolve a plan/ticket scope mismatch by narrowing the ticket below the issue. If a prior reviewer finding or a human note pushed you to *restore* scope, restoring it is correct — do not re-contract it on the next pass.

**If the complete work genuinely exceeds the line threshold, the answer is an epic split that *orders* the full scope across sub-tickets — never dropping scope.** A deferral to a later sub-ticket is legitimate only with a real seam (a genuine predecessor-stacking dependency, a contract that does not exist in the current repo, or true impossibility); size alone is never a reason to defer an implementable-now AC. If there is no natural seam, say so in the gate report and let the human decide.

## Length check

Count the lines of `.agent-loop/plan.md`. Target ≤ 80 lines. The orchestrator warns at 100 lines and rejects the iter at 200 lines. If you're above 100 lines, cut: most overage is impl-level detail that belongs in the impl diff, not the sketch. Merge sections or drop banned-details (filenames, line numbers, function signatures, variable names, regex syntax, glob patterns, SCOPE entries, named-standard control ids).

## What the gate catches vs. what's out of scope

**Plan-phase review catches (address these if you see them):**

- Missing or dropped acceptance criterion (AC in issue not covered by plan).
- Wrong architectural direction (boundary, flow, Conway alignment).
- Contract-breakage risk (API / schema / CLI / on-disk-format change without a versioning story).
- Scope creep (unsolicited public surface), OR scope drop / unjustified deferral — an issue AC dropped, or deferred to a sub-ticket / relabeled as a non-goal without a real, repo-verified seam (size is never a seam).
- Load-bearing test-surface absent from test-strategy section.
- Stacked-PR base-branch snapshot missing when base ≠ `main`.

**Impl-phase review catches (do NOT address these here):**

- Naming (variables, functions, types, tests, files).
- Regex content, glob patterns, SCOPE entries, shell control flow.
- Named-standard control ids (OWASP, CWE, WCAG SC) — those anchor to actual code.
- Comment style, docstring wording, prose polish.
- Abstraction granularity within a correctly-scoped component.
- Test assertion shapes and mock choices.

## Comment discipline check

Scan your plan's file sketch and test-strategy sections for any proposal of the form "add a comment", "document with a docstring", "add a `// ...` explaining X", or any implicit promise to write prose commentary in source files. The agent-loop convention forbids all source comments except terse godoc on exported identifiers (1-2 lines) and `// TODO(user):` tags. Replace any such proposal with a concrete alternative: a rename that makes intent obvious, a named test that asserts the invariant, or a new ADR file (check the repo for `decisions/` or `docs/adr/`; fall back to the commit body if no ADR convention exists). Per-project override: if the target repo's `CLAUDE.md` / `AGENTS.md` explicitly relaxes the rule, follow local.

## Your task

1. Read your `.agent-loop/ticket.md`, `.agent-loop/plan.md`, `.agent-loop/plan-gate-report.md`, and `.agent-loop/pr-context.md`.
2. Run the minimality pass above. Shrink first, then ask what's missing.
3. Apply the two reviewer skills below as your critique lens. The `review-intent` SKILL grades ticket↔plan consistency, AC churn risk, ticket adherence to repo standards, and plan↔issue fidelity. The `review-principal` SKILL grades cross-cutting plan judgment, internal consistency across the artifacts, and plan stability (fungible-mechanism pinning). Go section-by-section through each SKILL's Checks list and ask mechanically: "do MY artifacts honor THIS check?"
4. Pay special attention to the pattern-examples below (seeded from the prior iter's kept findings if available).
5. For every `major` or `blocker` gap you raise, CLOSE it now: edit `.agent-loop/ticket.md` and/or `.agent-loop/plan.md` directly (and update `.agent-loop/plan-gate-report.md` if a finding affects what the human should see at the gate). For `minor` findings, use judgment — close them if the fix is one or two sentences, otherwise leave them for the outer reviewer.
6. Iterate: re-read the revised artifacts and re-apply the skills. Stop when any of these holds:
   - Zero `major`/`blocker` findings remain (minors are acceptable for the outer reviewer).
   - The new findings set ⊆ the prior pass's findings (you're oscillating — commit and exit).
   - You've completed **3 inner passes**.
7. Commit the revised plan locally via the usual `[skip ci] plan:` prefix. Do NOT push — this is a local-only pass; the plan-gate-approval step is what eventually pushes.

## Pay special attention to issues similar to these

{{PRIOR_FINDINGS}}

## Output contract

When you stop, print exactly one of these terminal lines as the last line of your response:

```text
PLAN-SELF-REVIEW COMPLETE: <N> passes, <M> findings closed, <K> minor deferred
```

or

```text
PLAN-SELF-REVIEW SKIPPED: <reason>
```

**Ignore the reviewer skills' JSON output format sections.** You are NOT writing `review-intent.json` or `review-principal.json`. You are using their Checks + Standards + Finding-quality sections as your critique lens; the output of this pass is edits to `plan.md` + a local commit, not verdict files.

## Independence note

You wrote this plan. Same-author bias is real: you will naturally overlook gaps that a separate reviewer would catch. The prior-findings patterns above are your second-opinion lens — use them mechanically, not as a suggestion.

## Reviewer skill — review-intent (apply this as critique lens)

{{REVIEW_INTENT_SKILL}}

---

## Reviewer skill — review-principal (apply this as critique lens)

{{REVIEW_PRINCIPAL_SKILL}}

---

## Context you have

- iteration: {{ITERATION}}
- PR: #{{PR_NUMBER}} ({{HEAD_REF}})
- base ref: {{BASE_REF}}
- hard cap: 3 inner passes
