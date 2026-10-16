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

Under an `Assumptions` heading, list each behaviour the plan relies on that
no test environment in the repository exercises — the developer's host OS when the tests run elsewhere, a
real external tool the tests replace with a stand-in — and the real-run check that verifies it.

## Infrastructure plan

The deterministic test infrastructure the slices need — the harness, fakes, and fixtures — hermetic and
scriptable per turn.

## Slice plan

Break the work into RED/GREEN impl-slices — each complete and RED-first — plus a final integration slice.
Size the slices before enumerating them (see **Slice sizing** above). Enumerate the impl-slices in a
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

## Complexity drivers

Once the plan is drafted, find the acceptance criteria that drive most of its cost: a criterion that takes a
disproportionate share of the design, the tests or the slices; that brings in a new external system,
component or state; or whose failure paths need decisions the ticket does not settle. Under a
`## Complexity drivers` heading, name each such criterion, what it costs the plan, and one or more simpler
alternatives — a narrower criterion, a different mechanism, or a split into a follow-up ticket — with what
each alternative saves and loses, and your recommendation. Keep the list short and lead with the biggest
saving. Propose only: never apply an alternative yourself, so the plan still meets every criterion as the
ticket states it until the operator decides. When the operator decides, record it under the item as
`Operator decision (<date>): …` and revise the plan to match. When no criterion stands out, write `None.`
under the heading.

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
