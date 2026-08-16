## 28. The full-TDD development process — a chain of §27 loops

> **Status:** requirements, drafted **v2.144** from the `plan.md` design. **This is the full-TDD development process expressed on the §27 engine — §27.1's proof-of-generality turned into payoff.** §27.1 built three loops (`groom` / `plan` / `impl`) as the *same loop shape* over different data so a plan/impl assumption could never be hardcoded into the orchestrator; this section spends that generality by chaining more links of the same shape. Decisions are **P1–P10**.
>
> **The process expressed here** — for the epic: create epic → tracer-bullet slices → sub-tickets; for each ticket: groom → plan-bundle → build the deterministic infrastructure → RED/GREEN slices → an integration slice → polish; for each slice, a commit between each phase: RED tests → GREEN implementation → review-and-refactor.
>
> **The engine core does not change.** The whole process is a **longer chain of the loop the engine already runs** (`work-once → review-and-fix → consolidate → human-gate`, §27.3) over a different artifact at each link (§27.10 chaining). §28 adds only three bounded engine changes (P3–P5) and a body of **content** — five reviewer charters and a handful of work recipes, authored in the same style as the charters already in `example/loops-v2/`.
>
> **On any conflict, §27 wins for the loop mechanics; §28 governs only the process built on top of them.** §28 asserts **no supersession** over §27 — it is purely additive: a new side-effect kind, a def chained as three phase-loops, new completion clauses on §27.12(b), and new def content. Where §28 needs a mechanic §27 already specifies (the loop shape, the round report §27.5, the gate §27.9, chaining §27.10, the fake-agent seam §27.15), it **cites** §27 rather than restating it. A change here that finds itself editing a §27 mechanic has mis-cut the boundary.

### 28.1 Goal & boundary (P1)

- Express a complete **test-driven development process** — epic decomposition, per-ticket planning, deterministic-infrastructure construction, RED→GREEN→refactor slicing, integration, and polish — **on the existing §27 loop engine**, with a `git commit` between each phase and machine-checkable completion for the phases where "the agent says it's done" is not good enough.
- **In scope:** the new loop chain (§28.2); three additive engine changes — a **`commit` side-effect** (P3), **phase-as-a-loop** (P4), and **machine completion predicates** (P5); five new reviewer charters and their work recipes (§28.6); the epic overlay (§28.7).
- **Out of scope:** any change to the §27 loop shape, the round report, the consolidator, the gate, or the chaining/bootstrap machinery; the `ExecSideEffect` (§27.8, still unshipped — §28.5.4 explains why this design does not need it); per-verdict review vocabulary (the cousin work of [#102](https://github.com/dylanb/agent-terminal/issues/102), noted in §28.9).
- **Thesis (P1a): this is a longer chain, not a new engine.** §27.3's loop is artifact-agnostic by construction. RED, GREEN, and refactor are three more instances of it, chained by §27.10 hand-off; the planning steps collapse into one plan-bundle loop; the epic steps are §27.10 promotion. What is genuinely new is small and bounded, and it is enumerated in §28.10.

### 28.2 The loop chain (P2)

Each box is one instance of the §27.3 loop shape. Arrows are the §27.10 `inputs`/`outputs` artifact hand-offs — the same chaining that already turns groom → plan → impl, with more links.

```mermaid
flowchart TD
  RAW["raw GitHub issue"] --> GROOM["groom-loop<br/>(exists)"]
  GROOM -->|"groomed ticket"| PLAN["plan-bundle-loop<br/>(extends plan-loop)"]
  PLAN -->|"planning bundle:<br/>test-plan + tech-plan<br/>+ infra-plan + slice-plan"| EPICQ{"classified<br/>an epic?"}
  EPICQ -->|"yes"| PROMO["epic promotion<br/>(reuses §27.10)<br/>fan out to sub-tickets"]
  PROMO -->|"each sub-ticket<br/>re-enters here"| GROOM
  EPICQ -->|"no"| INFRA["infra-loop<br/>(new, impl-shaped)<br/>build the test harness"]
  INFRA -->|"infra commits"| SLICE1["slice-loop 1"]
  SLICE1 -->|"slice commits"| SLICEN["slice-loop N"]
  SLICEN -->|"slice commits"| INTEG["integration-slice-loop<br/>e2e RED to GREEN to refactor"]
  INTEG -->|"PR body published"| POLISH["polish<br/>(exists)<br/>orchestrator stands down"]
```

Each **slice-loop** is itself three tiny chained loops — this is *phase-as-a-loop* (P4):

```mermaid
flowchart LR
  RED["RED loop<br/>author failing tests"] -->|"commit RED"| GREEN["GREEN loop<br/>implement to pass"]
  GREEN -->|"commit GREEN"| REFAC["refactor loop<br/>review-and-fix cycle"]
  REFAC -->|"commit refactor"| GATE["slice gate<br/>approve to next slice"]
```

**Two levels of "slice", named to avoid collision (P2a).** The word *slice* appears at two granularities; every artifact must keep them distinct:

- **Epic-slice** = a **sub-ticket** — one unit of the epic plan's tracer-bullet decomposition, promoted to a self-contained, stacked sub-ticket via §27.10.
- **Impl-slice** = a **RED/GREEN unit** *inside* one sub-ticket's `slice-plan`.

### 28.3 Engine change #1 — the `commit` side-effect (P3)

The "commit between each phase" requirement is made first-class as a new **side-effect `kind`** alongside the §27.13 `gh` side-effects (`publish-pr-body`, `mark-ready`): a local **`git commit`** carrying the phase label (`RED: <slice>`, `GREEN: <slice>`, `refactor: <slice>`).

- Like every side-effect it is **best-effort and out-of-band** (§27.13) — it runs as an app operation, never as terminal injection, so a busy shell cannot block it.
- It **carries the identity of what it commits** (the phase and slice), and the receiver never re-derives that target from ambient state (the §6 IPC payload-identity rule).
- It **never modifies the user's `.gitignore`** (CODE-STANDARDS). Firing it advances `HEAD` by **exactly one commit** and leaves the tree clean; a pre-existing `.gitignore` is byte-for-byte unchanged — the RED-first pin for P3.

### 28.4 Engine change #2 — phase-as-a-loop (P4)

RED, GREEN, and refactor are **three separate single-work-turn loops, chained** (§27.10), **not** a new multi-work-turn loop with internal phase structure.

- This **reuses the §27.3 loop shape verbatim.** Each phase gets its own context boundaries, its own gate, its own `commit` (P3), and its own completion predicate (P5) *for free*, because each is an ordinary loop — rather than inventing "a loop with three work turns", a structure the orchestrator does not have and would need new machinery to run.
- **Consequence:** a slice-loop is a **sub-chain** (RED-loop → GREEN-loop → refactor-loop), and the per-ticket chain nests one sub-chain per impl-slice. The orchestrator already resumes a chain at the earliest turn whose output is missing (§27.12 auto-resume); nesting adds links, not concepts.
- **Recommended over** a phase sequence inside one loop, which would require new orchestrator state to track "which phase am I in" that the chain already expresses as "which loop am I in".

### 28.5 Engine change #3 — machine completion predicates for any repo, any framework (P5)

This is the one genuinely hard piece. §27.12 already says a turn is done only when a real done-signal fired **and** the artifact it was to produce exists and is well-formed — but "the tests now fail for the right reason" and "the tests now pass" are artifacts a naive check would gate by running the test command and reading its exit code, which bakes in framework and build-system assumptions. §28 removes those assumptions by **splitting #3 into two predicates with very different portability stories**, and by reusing the §27.5 trust model rather than inventing a cross-framework test interpreter.

#### 28.5.1 Frozen-tests — fully portable, pure machine, zero framework knowledge

The check "no test file changed during GREEN" is pure git:

```
git diff --name-only <RED-commit>..HEAD  ∩  test_globs  ==  ∅
```

Git is universal (the engine already requires it for pickup, branches, and PRs — §27.10). The only repo-specific input is **`test_globs`** — a list of path globs matched against the diff **with no knowledge of what a test is**. `<RED-commit>` is the SHA the RED loop's `commit` side-effect (P3) recorded in loop state. This half ships portably today; it is the same class of machine check as §27.5's "the report accounts for every persona" — **structural and tamper-evident, not semantic**.

**Detect-and-escalate, not a hard gate (P5a, operator decision — §28.8).** A detected test-glob change since the RED commit is **recorded as a flag** on the turn's artifact and does **not** fail the turn. The flag feeds the review round — the `regression-guard` persona (§28.6) judges whether the change was a legitimate RED correction or a weakening — and the human gate, which decides. Detection is machine and tamper-evident; **disposition is persona + human.** A wrong RED test still has the `redo` lever (§27.9); freezing is deliberately not a hard block that could deadlock a slice.

#### 28.5.2 Ran / passed / failed-by-assertion — cannot be pure-machine cross-framework

The irreducible difficulty: **an exit code cannot distinguish an assertion failure from a compile failure.** `pytest`, `go test`, `cargo test`, and `vitest` all exit non-zero for both. A purely-machine, purely-portable predicate that told "valid RED" (ran, expectation unmet) from "invalid RED" (never compiled) would require shipping and maintaining an **output parser per runner** — exactly the machinery §27 exists to avoid. So §28 reuses the §27.5 round-report trust split, which faces this identical shape and refuses to solve it by machine:

**(a) The engine owns tamper-evident ground truth — portable, no framework knowledge:**

- `git diff` for frozen-tests (§28.5.1).
- The RED commit's diff **must add lines in `test_globs` files** — catching "you never wrote a failing test" machine-side, portably.
- The test command's **real exit code**, recovered *best-effort* from the tool/session log the cost meter already sweeps (§27.11) — that log is "an external dependency the app does not control" (§27.4), so the recovery **tolerates drift**. Where recoverable, the engine enforces the **unambiguous direction**: exit 0 ⇒ the agent may not claim RED; exit non-zero ⇒ the agent may not claim GREEN.

**(b) The agent owns framework interpretation.** It knows `pytest` from `vitest`, reads the raw output, and classifies it into a fixed, framework-neutral **outcome vocabulary** — the cousin of the §27.5 disposition set:

| outcome | means | RED requires | GREEN requires |
|---|---|---|---|
| `passed` | ran, all green | ✗ | ✓ |
| `failed-assertion` | ran, an expectation was unmet | ✓ | ✗ |
| `errored` | never ran: compile / import / collection error | ✗ | ✗ |
| `no-tests-selected` | the selector matched nothing | ✗ | ✗ |

The vocabulary is portable **by construction** — it names the *category* of outcome, not the runner. Every framework maps onto it:

| framework | `failed-assertion` looks like | `errored` looks like |
|---|---|---|
| vitest / jest | `AssertionError`, `expect` diff | `SyntaxError`, `Cannot find module` |
| pytest | `assert` failure, `E   assert` | `ERROR ... collection`, `ImportError` |
| go test | `--- FAIL` + assertion line | `build failed`, `undefined:` |
| cargo test | `assertion failed`, `panicked` | `error[E…]`, `could not compile` |

**(c) The agent writes the outcome into a result file whose *shape* the engine validates** — exactly like the round report. The agent classifies (marks its own homework, §27.5's N5a risk); the engine bounds it with the exit-code direction from (a); the **raw captured output is versioned next to the classification**; and the `red-authenticity` reviewer plus the human gate are the backstop for a misclassified assertion-vs-compile. This is the same three-part bound §27.5 already accepts — a structural machine check, a versioned auditable artifact, and the human gate.

#### 28.5.3 Completion clauses slot into §27.12(b) — not a parallel system

Each new turn type gains an artifact-check clause, exactly as the round report and the consolidator output do today (§27.12):

- **RED turn done** ⟺ `{diff added a test_glob file}` ∧ `{result file shape-valid}` ∧ `outcome == failed-assertion` ∧ `{exit ≠ 0 where recoverable}`.
- **GREEN turn done** ⟺ `{result file shape-valid}` ∧ `outcome == passed` ∧ `{exit == 0 where recoverable}` ∧ `{build outcome == built}`. **Frozen-tests runs here as detection, not a block (P5a):** a test-glob file changed since the RED commit is recorded as a flag and does **not** fail the turn; the flag feeds `regression-guard` and the human gate.
- **refactor round done** ⟺ `{result file shape-valid}` ∧ `outcome == passed`. A refactor may legitimately restructure a *fixture*, so the same changed-test flag is raised for `regression-guard` and the human rather than blocking.

A malformed result takes the existing **retry-then-`error`** path of §27.12; a persisted `error` is human-owned and survives a relaunch.

#### 28.5.4 Where the repo-specific knowledge lives — and why trust stays put (P5b)

Two things carry all repo-specific knowledge, and **neither is a program the engine executes:**

- **The engine never runs the test or build command. The agent does** — it already runs the build in today's impl work turn. So this does **not** reintroduce the §27.8 `ExecSideEffect` the spec ships-but-parks on trust grounds: there is **no engine-side shell interpolation** (no CWE-78 at the engine boundary) and **no per-def-origin trust decision to reopen**. The engine's job is capture + shape-validate only.
- **The "how to run it" is data referenced as *guidance* in the recipe** — a **standalone per-repo `loop-capabilities.yaml`** (operator decision — §28.8): `test_globs`, `test_command`, `build_command`, and an optional `select_template` for a slice's targeted subset. One file per repo; every loop def references it. Frameworks differ only in these *values*; the engine code is identical across every repo. An unusual runner just fills in different strings.

#### 28.5.5 Shared-semantics placement (P5c)

The outcome vocabulary is single-sourced in **`src/shared/phaseOutcome.ts`**, consumed by the prompt composer (tells the agent what to write), the completion predicate (validates the result file), and the tests — **exact-string, closed set, never normalized**, mirroring `DISPOSITIONS` and `GATE_DECISION_OPTIONS` (§27.5). The result-file grammar is single-sourced the way `roundReport.ts` is (§27 N3 changelog): **one writer** (the recipe), **one predicate**, **one canonical example** anchoring the prompt few-shot, the predicate happy-path test, and the fake-agent e2e. A recipe that instructs the agent to produce the result file is a *writer* in the shared-semantics contract (CODE-STANDARDS): its vocabulary derives from `phaseOutcome.ts`, and it embeds a canonical example asserted well-formed against the predicate.

#### 28.5.6 Honest boundary and limits (P5d)

- **Frozen-tests is fully machine and fully portable; pass/fail *direction* is machine-bounded and portable; assertion-vs-compile *reason* is agent-classified and human-backstopped.** That residue cannot be made pure-machine across all frameworks without shipping per-runner adapters; §27's answer to exactly this shape is classify-and-backstop, not interpret.
- A repo with **no machine-runnable tests** degrades to frozen-tests + agent classification + human gate — still coherent.
- **Flakiness** stays the human gate's problem, not this predicate's — which is the reason for the P8 timing decision: a targeted subset per GREEN turn, the full Podman e2e only at the integration gate and polish.

### 28.6 Personas — reuse, repurpose, create (P6)

The code-producing loops need almost nothing new — the 12 impl and 6 plan personas are already in `example/loops-v2/` at full fidelity. The new charters are all about **planning artifacts** and **phase discipline**.

**Per-loop catalog (P6a).**

| Loop | Work recipe (author) | Review catalog | New charters |
|---|---|---|---|
| **groom-loop** | exists | `intent` (exists) | none |
| **plan-bundle-loop** | new: author the four-file bundle | all 6 plan personas + 3 new | `test-architect`, `determinism`, `tracer-slicer` |
| **infra-loop** | new: build harness / fakes / fixtures | impl `tests`, `security`, `taint`, `reliability`, `maintainability`, `conventions`, `architecture` + `determinism` | (`determinism` shared) |
| **RED loop** | new: author failing tests | impl `tests`, `intent` + `red-authenticity` | `red-authenticity` |
| **GREEN loop** | new: implement to pass | the full impl-12 + `regression-guard` | `regression-guard` |
| **refactor loop** | none — it *is* review-and-fix | the full impl-12, maintainability-led | none |
| **integration-slice-loop** | new: wire end-to-end + e2e | the full impl-12 + `tracer-slicer` + accessibility emphasis | none new |

**The five new reviewer charters (P6b).** Each is authored in the structure of the ported charters — the shared fragments (`00-preamble`, `01a-stack-translation`, `07-depth-probes`) composed in, a lane statement, and signature depth probes — and each carries a distinctive **marker** the content-parity test pins (mirroring security → "Aperture", tests → "hermeticity"):

1. **`test-architect`** — marker **"AC-to-test bijection"**. Every acceptance criterion maps to a test that asserts *observable behavior* (return values, IPC payloads on a contract channel, DOM the user sees — never a private call or internal shape), at the right layer (unit / integration / e2e), in RED-first order, with injection seams naming *domain concepts* not mechanism shapes. This is the CLAUDE.md "tests exercise observable behavior" and "an injection seam exposes a domain concept" rules turned into a reviewer.
2. **`determinism`** — marker **"Scriptable-per-turn"**. The test infrastructure is hermetic — no wall-clock / `Math.random()` / network / real time; the fake-agent seam is scriptable per turn (§27.15); fixtures are stable and self-contained; a first-run writer's RED test deletes the target root first (the CLAUDE.md fresh-machine rule).
3. **`tracer-slicer`** — marker **"Thin-but-complete"**. The slice breakdown is genuinely tracer-bullet-shaped (TRACER-BULLET.md): each impl-slice is thin *but complete* (main → `ipc.ts` → preload → renderer → visible UI), RED-first with an `_electron` e2e, fireable from an existing UI control, with real backing; and there is a final integration slice. Rejects a "slice" that is a horizontal layer.
4. **`red-authenticity`** — marker **"Fails for the right reason"**. The RED tests fail by *assertion*, not by a missing import / compile error / collection error; the failure message describes the intended behavior; no RED test asserts implementation; the `errored`-vs-`failed-assertion` classification (§28.5.2) is correct. This is the human-judgment complement that makes "marks its own homework" (§28.5.2c) bounded.
5. **`regression-guard`** — marker **"No vacuous green"**. The GREEN implementation satisfies the *intent* of the RED tests, not merely their letter; no trivially-true test was slipped in to pass; in refactor, changes are behavior-preserving and no assertion was weakened. **It reads the machine's changed-test flag (§28.5.3) and recommends a course of action to the human at the gate** — legitimate RED correction vs. weakening. The machine proves *which* files changed; this persona judges *why*.

**New work recipes (P6c).** One `work.md` per new loop — author the test plan, author the infra plan, author the slice plan, build the infra, write the RED tests, implement the GREEN. Refactor needs none (it is the review-and-fix cycle). Each recipe references `loop-capabilities.yaml` (§28.5.4) as guidance, and — per §28.5.5 — a recipe that instructs the agent to write the outcome result file derives its vocabulary from `phaseOutcome.ts` and embeds a canonical example asserted well-formed against the predicate.

### 28.7 The epic level maps onto §27.10 (P7)

The three epic steps are §27.10's existing epic promotion:

1. **create epic** = groom + plan at epic scope, plan classified `epic`.
2. **create tracer-bullet slices** = the plan-bundle-loop's slice breakdown, reviewed by `tracer-slicer`, at **ticket granularity** (each epic-slice becomes a sub-ticket).
3. **create sub-tickets** = confirm-first promotion (§27.10): self-contained, stacked sub-tickets, each carrying its AC portion + the plan verbatim with the slice delimited, an epic link, and the preceding slice's issue number; `agent-loop/ready` + `agent-loop/subticket` applied (§27.10's recorded operator override — approving the epic plan is the human vetting act).

Each sub-ticket then runs the full per-ticket chain (§28.2). **Settled (P7a, decision — §28.8):** the epic plan owns only the **coarse** decomposition into sub-tickets; each sub-ticket runs its own test / infra / slice planning, because the epic plan cannot yet know each slice's test seams.

### 28.8 Decisions settled (P8)

1. **Gate granularity → one `plan-bundle-loop`.** The per-ticket planning steps (test plan, tech plan, infra plan, review-and-iterate, slice breakdown) collapse into a **single planning loop**: its work turn produces all four planning files, its review-and-fix cycle *is* the "review all the above, iterate" step, and it has **one** human gate. The §27.9 interrupt model lets the operator let it run and step in when needed.
2. **Epic planning → per sub-ticket** (P7a): the epic plan owns only the coarse decomposition; each sub-ticket plans its own seams.
3. **Frozen-tests → detect-and-escalate, not a hard gate** (P5a): the machine *detects* a changed test file and flags it to `regression-guard`, which recommends a course of action to the human at the gate — detection is machine, disposition is persona + human.
4. **Full-suite timing → targeted per turn, full e2e at gates.** RED/GREEN/refactor predicates run the slice's targeted + affected tests; the **full Podman `_electron` e2e** runs only at the integration-slice gate and final polish — matching CLAUDE.md's "full suite before *done*", where *done* is the ticket's end, not every micro-phase.
5. **Capabilities file → a standalone per-repo `loop-capabilities.yaml`** (§28.5.4), referenced by every loop def as data, never executed by the engine.
6. **Spec §28 first.** This section is written and lands **before** any of the engine changes it describes, mirroring §27's N0 ("the contract the code implements. No code."). Every downstream slice cites §28, and the spec wins on any conflict.

### 28.9 Relationship to [#102](https://github.com/dylanb/agent-terminal/issues/102)

Issue #102 (the deferred per-persona verdict / pr-description / handoff work) is a **cousin**: its per-persona verdict vocabulary and this section's `phaseOutcome` vocabulary are both closed, exact-string, shared-sourced sets in the §27.5 mold. If #102's verdicts land first, §28 builds on the same shared-vocabulary machinery rather than duplicating it. They are separate initiatives and separate themes; the overlap is noted so neither re-invents the vocabulary plumbing.

### 28.10 Build — tracer-bullet slices (S0–S8)

Per the CLAUDE.md tracer-bullet rule, each slice spans main → `src/shared/ipc.ts` → preload → renderer, is fired from an **existing** loop-panel / gate control, and is proven by a Playwright `_electron` e2e on a real PTY, with the §27.15 fake-agent seam extended to script the new outputs. One theme per PR; RED-first throughout. The fake-agent must gain: writing the **result file** (outcome classification), driving **git state** (add a test file for RED; touch/don't-touch a test file for the frozen check), and reporting a scripted **exit code** the log-sweep recovers.

- **S0 — Spec §28 (this section). No code.** The contract the downstream slices cite; the spec wins on any conflict. (Operator decision — §28.8.6.)
- **S1 — `phaseOutcome` vocabulary + portable frozen-tests detection.** `src/shared/phaseOutcome.ts` (the closed set) and the pure-git frozen-tests check in main (§28.5.1). RED-first over git fixtures; no UI. Foundation for everything below.
- **S2 — the `commit` side-effect (P3).** A loop turn commits; the loop panel shows the commit landed. **e2e:** fire a loop whose gate side-effect commits; assert `HEAD` advanced by one, tree clean, `.gitignore` untouched.
- **S3 — the RED loop + RED predicate (P4 + P5).** Completion requires `failed-assertion` + a test file added (§28.5.3). **e2e:** a fake-agent that writes a failing test + a well-formed result file → RED complete; a fake-agent that writes a *passing* test drives retry-then-`error`.
- **S4 — the GREEN loop + GREEN/frozen predicate.** Completion requires `passed` + build `built`, with frozen-tests **detected and flagged**, not blocked (§28.5.3, P5a). **e2e:** a clean green advances and commits; a fake-agent that touches a test file raises the changed-test flag.
- **S5 — the refactor loop.** Reuses review-and-fix (§27.3) with the softer frozen+green round predicate (§28.5.3).
- **S6 — the five new charters + the new work recipes.** Content, pinned by a content-parity test in the mold of `loopsV2ContentParity.test.ts` (identity marker, shared fragments, no dead tokens; the recipe↔predicate canonical example asserted well-formed).
- **S7 — the per-ticket chain end-to-end.** groom-loop → plan-bundle-loop → infra-loop → slice-loop×N → integration-slice-loop → polish, wired as one flow, proven by a fake-agent e2e with `gh` recorded; the full Podman e2e green at the integration gate.
- **S8 — the epic overlay.** plan-bundle classified `epic` → `tracer-slicer`-reviewed decomposition → §27.10 promotion → each sub-ticket runs the per-ticket chain.

### 28.11 What §28 adds to §27 (the additive-change map)

Everything §28 introduces is additive; nothing narrows an existing §27 contract. Recorded so the boundary is checkable.

| §28 addition | rests on | new surface |
|---|---|---|
| `commit` side-effect (P3) | §27.13 side-effect kinds | a new best-effort side-effect `kind`; no contract narrows |
| phase-as-a-loop (P4) | §27.3 loop shape, §27.10 chaining | new loop defs chained as sub-chains; no new orchestrator primitive |
| completion predicates (P5) | §27.12(b) artifact check | new per-turn artifact-check clauses; `phaseOutcome.ts` (closed set, §28.5.5) |
| `loop-capabilities.yaml` (P5b) | none — data only, engine never executes it | a per-repo data file referenced by defs |
| five charters + recipes (P6) | §27.4 pull model, §27.8 def catalog | new def content, pinned by content-parity tests |
| epic overlay (P7) | §27.10 promotion | reuses the promotion contract; adds an epic classification path |
