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

The RED/GREEN impl-slices plus a final integration slice, each thin but complete and RED-first.

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
