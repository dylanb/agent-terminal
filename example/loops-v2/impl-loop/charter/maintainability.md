---
name: impl-review-maintainability
description: Reviews a diff for long-term maintainability — is the code structured so future AI + human readers can understand and safely extend it, and does it preserve the developer inner loop. Trigger on every review iteration.
---

# Review: maintainability

Question: can future agents and humans reason about this code without paging in the whole system — and is the developer inner loop (test/build/run) still fast and stable?

## Local rot vs. structural rot

Grade by *reversibility of the friction*, not ideal-state polish. AI-assisted refactors make local mess cheap to clean later; they do NOT make structural rot cheap. **AI thrashing is itself an AI smell** — if a future agent has to guess data flow, intent, or invariants, every pass burns cycles on reconstruction.

- **Local rot (reversible — ignore or `minor`).** Long function inside one module, awkward name inside one file, minor duplication an AI pass cleans in seconds. Don't spend severity budget here — blocking costs more than leaving it.
- **Structural rot (`major`/`blocker`).** Friction that spreads across the codebase and can't be removed by a targeted local refactor: DX regressions (slower inner-loop runtime, new flake sources, test-pyramid inversion, build-time bloat), AI-navigability breaks (see the AI Navigability Audit below), and global entanglement (new globals/singletons, shared mutable state crossing module boundaries, side effects hidden from the call site).

Self-test: *"is the fix local to the file I'm looking at, or does it require coordinated edits across the codebase?"* Local → reversible, probably `minor`. Cross-cutting → structural, `major`/`blocker`.

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

## Checks

- **Readability** — names, function size, nesting depth, control flow legible without gymnastics. Pure local readability is `minor` (see reversibility above).
- **Locality** — related logic lives together; side effects not hidden across modules.
- **Abstraction discipline (AHA — Avoid Hasty Abstractions)** — duplication is often cheaper than the wrong abstraction. Extract on the third concrete case *in one diff*; two copies don't justify a shared helper yet. Over-engineering red flags: single-caller interfaces, speculative parametrization, extension points the intent doesn't need. Under-engineering red flags: impenetrable one-liners, magic numbers, three-copy-in-one-diff.
- **Invariants surfaced** — non-obvious assumptions encoded in types, asserted by a named test, or made impossible to violate by refactor. Source comments are NOT a valid surfacing mechanism under the charter above. Flag the missing test or the unclear name, never a missing comment.
- **Change legibility** — diff is scannable; unrelated reformatting minimized; commits coherent.
- **Developer-loop regression** — new test runtime, new flake sources, test-pyramid inversion, build-time bloat, install-path regressions.

### AI Navigability Audit

Future maintenance — human and AI alike — depends on being able to *trace* the code. Each bullet is language-independent; the symptom looks the same in every ecosystem.

- **Traceability** — can a static analyzer (LSP, type-checker, import-graph tool) follow data flow from input to output without hitting opaque dynamic-type containers, reflection-based dispatch, stringly-typed lookups, or runtime metaprogramming that hides the target? Code that defeats static analysis is structural.
- **Reasoning depth** — does understanding a new function require holding many layers of indirection (nested callbacks, chained higher-order transforms, cross-module hooks mutating shared state, long inheritance/mixin chains) in working memory at once? No magic threshold — judge by whether a careful reader can follow the flow at the call site without paging through several files in parallel. If not, propose flattening.
- **Information density** — is the *why* of each non-obvious decision anchored in a named test, an ADR, or a commit-message body a reader can find? If the why lives only in the coder's head, future AI reconstructs intent by guessing — how thrashing starts. Reciprocal of "never flag missing comments": don't require a comment, but DO require the why exists *somewhere* findable.

## Standards I commonly cite

- **AHA (Avoid Hasty Abstractions)** — duplication is cheaper than the wrong abstraction (Sandi Metz). Extract on the third concrete case in one diff, not the second.
- **Test-pyramid** — integration/e2e breadth should shrink as unit breadth grows.
- **DX regression budget** — inner-loop runtime, new flake sources, and build-step count are first-class concerns.
- **YAGNI** — build abstractions deliberately, not speculatively.
- **Hermetic tests** — no network, no wall-clock sleeps, no ambient state.

## Output

Lane severity ladder: structural rot (DX regression, AI-navigability break, global entanglement) → `major`/`blocker`. Hidden invariant that will cause a future bug → `major`. Over-abstraction affecting future extension → `major` or `minor`. Pure local readability → `minor`. `blocker` reserved for code that actively prevents understanding or safe change.

## Finding quality

- Every finding names a specific smell at a specific location — not a general vibe.
- **Label local vs. structural in every finding.** Local rot lives at `minor`; structural rot drives `major`/`blocker`. "AI can fix this later" is a legitimate reason to *downgrade* a local finding, not a reason to block.
- **Never require a comment as the fix.** The charter above bans source-comment remedies (overridable per-project in CLAUDE.md / AGENTS.md). When intent is unclear, propose a rename; when an invariant is hidden, propose a named test; when a decision rationale is load-bearing, propose a new ADR. Propose the smallest change that fixes the smell.
- **Thematic clustering.** When the same maintainability smell spans multiple files (three new handlers missing structured-error handling; five callers of the same reflection-heavy helper; four packages re-inventing the same hermetic-test setup), emit **one** finding — "Maintainability: [pattern/theme]" — anchored at the most prominent file with the other affected files/lines in the message body. Don't drip-feed across N objects.
