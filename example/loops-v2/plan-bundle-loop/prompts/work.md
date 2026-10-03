# plan-bundle-loop — work turn

Produce the planning bundle for the linked ticket per `CLAUDE.md`, as the four delimited sections below.
Read `loop-capabilities.yaml` for the repo's `test_command`, `build_command`, and `test_globs`, and target
those in the test, infrastructure, and slice plans. Produce the `planning-bundle` artifact.

## Test plan

Map every acceptance criterion to an observable-behavior test at the right layer (unit / integration /
e2e), in RED-first order, with injection seams named for the domain concept the unit needs.

## Technical plan

The smallest correct design that satisfies the ticket — the files, seams, and contracts it touches, and
the shared definitions it single-sources.

## Infrastructure plan

The deterministic test infrastructure the slices need — the harness, fakes, and fixtures — hermetic and
scriptable per turn.

## Slice plan

Break the work into RED/GREEN impl-slices — each complete and RED-first — plus a final integration slice.
Size the slices before enumerating them (see **Slice sizing** below). Enumerate the impl-slices in a
`## Impl-slices` block so the plan-bundle gate can source their COUNT into the `slices` flow input that
drives the impl-slice×N loop (§28.4.1): each `### Impl-slice N — <title>` carries that slice's
`Acceptance criteria:` line, with DISTINCT indices. The final integration slice runs once after the loop and
is NOT an `### Impl-slice` entry. Emit the block in this shape:

```text
## Impl-slices

### Impl-slice 1 — Slice 1 of the feature
Acceptance criteria: acceptance criterion 1 is observably satisfied

Plan for impl-slice 1: the thin RED/GREEN vertical that delivers criterion 1 end to end.

### Impl-slice 2 — Slice 2 of the feature
Acceptance criteria: acceptance criterion 2 is observably satisfied

Plan for impl-slice 2: the thin RED/GREEN vertical that delivers criterion 2 end to end.
```

### Slice sizing

A slice exists so that it can be tested end to end on its own — not so that every piece that *could* be
tested end to end gets a slice of its own. Every impl-slice runs a full red→green→refactor cycle with its own
review rounds, so a slice too small to carry real work is pure overhead. Size them with these rules of thumb:

- Plan **no more than 5 impl-slices** per ticket. A small ticket is one slice.
- Estimate each slice's size (production plus test lines changed). Aim for slices of **more than 200 lines**,
  and let no slice fall below **one eighth** of the ticket's total estimate.
- Fold a slice that misses those marks into the slice before or after it, and give the combined slice every
  AC both carried. Keep folding until each slice clears the floor or the ticket is a single slice.
- Group by shared work: slices that extend the same test file, doc, or changelog entry belong together, and
  so do pinning tests of behavior that already holds (their GREEN has nothing to change).

This is planning guidance for you alone; reviewers do not grade slice count or size.

## Epic classification (§28.7)

Judge whether the ticket is an **epic** — work that decomposes into more than one self-contained,
independently-shippable sub-ticket at ticket granularity. When it is, add a `Classification: epic` line and a
`## Sub-tickets` block that partitions the acceptance criteria across the slices with no gaps or overlap
(reviewed by `tracer-slicer`). Each `### Sub-ticket N — <title>` block carries its slice's acceptance criteria,
the preceding slice it depends on, and the approved plan for that slice **verbatim** (it becomes the created
sub-ticket's body), in this shape:

```text
Classification: epic

## Sub-tickets

### Sub-ticket 1 — Slice 1 of the feature
Acceptance criteria: acceptance criterion 1 is observably satisfied
Depends on: none

Plan for slice 1: the thin vertical that delivers criterion 1 end to end.

### Sub-ticket 2 — Slice 2 of the feature
Acceptance criteria: acceptance criterion 2 is observably satisfied
Depends on: #1

Plan for slice 2: the thin vertical that delivers criterion 2 end to end.
```

A single-ticket plan omits the classification line. Approving an epic plan fans it out, confirm-first, into the
stacked sub-ticket chain and turns the epic into a tracking issue (§27.10 / §28.7).

## Acceptance criteria are non-negotiable

No acceptance criterion may be deferred, narrowed, or dropped from the plan. Every AC must be assigned to a
slice that implements it, and the final integration slice must wire every AC into production unless the plan
explicitly records that wiring a non-goal. The only way an AC leaves scope is explicit, prior operator
permission (a non-goal recorded in the ticket, or a split into an already-filed sub-ticket of the same epic);
never self-defer an AC to "a later slice" without it.
