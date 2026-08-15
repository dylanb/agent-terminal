# loops-v2 port — functional-gap report

## Why this document exists

The `example/loops/` tree — the retired **Go `agent-loop` engine**'s LoopDefs (schema_version 4) — was
restored during a merge of `origin/main`. Its full-fidelity **review content** was then ported into
`example/loops-v2/` — the format the live **§27 in-terminal loop engine** reads — before `example/loops/`
is deleted. This file is the record, captured **before** that deletion, of everything v1 carried that the
v2 engine cannot reproduce, so nothing is silently lost.

The port was deliberately scoped to **prompt/charter text only** (no `src/` or v2-schema changes), split
from the engine work that would close some of these gaps. The sequencing and dispositions were operator
decisions.

## What the port carried at full fidelity

**18 charter files** (`example/loops-v2/{impl,plan}-loop/charter/*.md`). Each is the v1
`skills/<persona>/SKILL.md` reproduced **verbatim**, with its two template tokens resolved in place:

- `{{CHARTER}}` → expanded, at its exact location, to the engine-agnostic shared charter fragments in v1
  `compose` order: `00-preamble`, `01-cite-named-standards`, `01a-stack-translation`, `02-severity-rubric`,
  `04-missing-entirely` (impl), `05-source-comments` (impl) + `lean-mvp-directive`, `07-depth-probes`,
  `99-pr-context` (impl). Static tokens resolved to shipped defaults: `PLAN_LINE_THRESHOLD`=1000,
  `PLAN_LINE_TAKE_ACTION`=2000; `PLAN_MODE_DIRECTIVE`→`plan-mode-directive` (plan) / empty (impl).
- `{{REVIEW-INSTRUCTIONS}}` → **removed** (see gap B — the retired JSON review envelope).

Delivery: the v2 engine hands a reviewer only its charter **path**; the reviewer subagent opens and reads
the whole file (`src/main/reviewTurn.ts`). Full-length charters therefore reach the reviewer verbatim.

**4 recipes** (`{impl,plan}-loop/prompts/{work,consolidate}.md`) were enriched with the engine-agnostic
**discipline** sections of the v1 `work-impl` / `work-plan` / `consolidate` prompts (principal-engineer
role, Lean MVP, TDD red→green→refactor, UI discipline, pre-push self-check, folded self-review;
product-owner triage, scope-routing three buckets, relevance triage, dismissal rules, style) — copied
verbatim at the section level — while keeping v2's own mechanics (push-then-signal; `clean` / `another
round` / `stop for a human` verdict). `{{PHASE}}` was resolved to `impl`/`plan` at port time.

Content parity is pinned by `tests/integration/loopsV2ContentParity.test.ts`.

## The gaps

### A. Deferred to named follow-up engine PRs (need v2 schema + engine + tests)

| Capability | v1 source | v2 today | Follow-up |
|---|---|---|---|
| **Verdicts** | `charter/08-legal-verdict-strings` + yaml `verdicts:` — persona `clean`/`concerns`, consolidated `clean`/`needs-work`, synonym maps, `severities: [minor, major, blocker]` | consolidator emits `clean` / `another round` / `stop for a human`; reviewers fix in-session, no per-persona verdict | **verdicts PR** — restores `08` content to the charters |
| **PR-description authoring** | `prompts/pr-description.md`, incl. OWASP-A09 / CWE-540 / CWE-532 secret-redaction rules | gate side-effect `publish-pr-body` publishes the **plan** artifact as the PR body | **pr-description-slot PR** |
| **Human-gate handoff report** | `prompts/handoff-impl.md` / `handoff-plan.md` | `report.sections: [summary, findings, disposition]` — mechanism only, not authored to the v1 template | **handoff-slot PR** |

### B. Documented gaps — retired mechanisms **not** being restored

Recorded, not reconstructed. Every one has no v2 top-level key / engine concept.

- **Per-cycle severity floor** — `charter/03-severity-floor` + `phases.severity_floor_track` +
  `{{SEVERITY_FLOOR}}`. v2 has no per-iteration floor.
- **Lanes / adjacency / lane routing** — yaml `lanes`+`adjacent`, `lane_routing`, and
  `charter/06-considered-dropped` (`considered_dropped[]` + the closed `lane_handed_off_to` value-space).
  v2 reviewers do not hand off between lanes; there is no `considered_dropped` field.
- **Highways & warmers** — yaml `highways` (thinking/normal, `warmer`).
- **Rosters & narrowing** — yaml `rosters`/`default`/`narrowing_phases`; v2 round rosters are the
  consolidator's per-round choice.
- **Phases** — yaml `phases` (`entry_status`, `chain_dispatch`, `exit_predicate`); v2 is single-phase per
  loop (impl-loop is impl; plan-loop is plan).
- **Scope override / special routing** — yaml `scope_override` (the Go-specific `_test.go` / `testdata`
  test-only downgrade) and the `actor_roles` routing described in the v1 header (principal/security stay
  full-scope; tests downgrades on test-only deltas; accessibility filters on a11y files). No v2 field.
- **The Go JSON review envelope + `agent-loop validate review` CLI** — `charter/09-review-instructions`.
  v2 reviewers do not emit `review-<persona>.json` files, and there is no validator CLI.
- **`adapters`, `state_extension`, `resume_contract`, `cli`, `config_bindings`** (model/effort pins), and
  the first-class **`labels`** taxonomy. v2 exposes only `pickup.initial_labels`.
- **The retired epic model** — `epic-promote`, `## Epic Breakdown`, `## Per-sub-ticket ACs`, `EpicState`
  (the bulk of `work-plan.md`). Removed in v2 in favor of self-contained sub-tickets (#98 / #99).
- **`.agent-loop/` runtime artifact paths** — `pr-context.md`, `plan.md`,
  `reviews/{iter}/consolidated.json`, `human-notes/{iter}.md`, `epic-sub-ticket-brief.md`.
  `src/main/appLoopEngine.ts:34` — the §27 engine keeps its state **disjoint from the retired engine's
  `.agent-loop/`**.

### C. Dropped as obsolete

- **`prompts/epic-framing-note.md`** — the per-sub-ticket-brief step. Obsolete: epics were removed as an
  engine concept.

### D. Runtime tokens with no v2 substitution engine

v2 performs **no** `{{token}}` substitution (0 matches in `src/`). Static tokens were resolved at port
time; the following **runtime** tokens have no v2 injector, and the content that depended on them was
dropped: `SEVERITY_FLOOR`, `ITERATION`, `PR_NUMBER`, `PR_TITLE`, `HEAD_REF`, `BASE_REF`, `REVIEW_DIR`,
`PHASE` (resolved to `impl`/`plan` at port time), `CLEAN_POLICY`, `PREV_ITER`, `PRIOR_FINDINGS`,
`CI_SUMMARY`, `SUB_TICKET_INDEX`, `SUB_TICKET_TOTAL`, `REVIEW_INTENT_SKILL`, `REVIEW_PRINCIPAL_SKILL`.

### E. Semantic-vocabulary mapping (kept verbatim, read as v2)

To honor "full equivalence, no paraphrasing," domain prose that names the retired **output vocabulary** was
kept verbatim inside otherwise-portable charter/prompt sections rather than reworded. Read it in v2 as:

- **`verdict` (`clean`/`concerns`), `considered_dropped[]`, `intent_audit`, `findings_kept`,
  `findings_dismissed`, `escalations[]`, `follow_up_items[]`, `consolidated.json`** — the v1 JSON
  review/consolidation schema. In v2 the reviewer fixes findings in-session and the consolidator emits a
  verdict via each recipe's **"## Your verdict this round"** section; these names are guidance on how to
  *think about* a finding's disposition, not literal output fields. (Some of this vocabulary — the
  `verdict` values — is scheduled to become real again in the **verdicts PR**, gap A.)
- **"lane"** — synonymous with the reviewer's specialty / persona.
- **`.agent-loop/…` paths in kept prose** — the retired engine's runtime area; the v2 engine supplies the
  equivalent context through its own inputs / boundaries.
