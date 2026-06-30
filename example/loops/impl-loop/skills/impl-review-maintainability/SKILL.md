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

{{CHARTER}}

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

{{REVIEW-INSTRUCTIONS}}

Lane severity ladder: structural rot (DX regression, AI-navigability break, global entanglement) → `major`/`blocker`. Hidden invariant that will cause a future bug → `major`. Over-abstraction affecting future extension → `major` or `minor`. Pure local readability → `minor`. `blocker` reserved for code that actively prevents understanding or safe change.

## Finding quality

- Every finding names a specific smell at a specific location — not a general vibe.
- **Label local vs. structural in every finding.** Local rot lives at `minor`; structural rot drives `major`/`blocker`. "AI can fix this later" is a legitimate reason to *downgrade* a local finding, not a reason to block.
- **Never require a comment as the fix.** The charter above bans source-comment remedies (overridable per-project in CLAUDE.md / AGENTS.md). When intent is unclear, propose a rename; when an invariant is hidden, propose a named test; when a decision rationale is load-bearing, propose a new ADR. Propose the smallest change that fixes the smell.
- **Thematic clustering.** When the same maintainability smell spans multiple files (three new handlers missing structured-error handling; five callers of the same reflection-heavy helper; four packages re-inventing the same hermetic-test setup), emit **one** finding — "Maintainability: [pattern/theme]" — anchored at the most prominent file with the other affected files/lines in the message body. Don't drip-feed across N objects.
