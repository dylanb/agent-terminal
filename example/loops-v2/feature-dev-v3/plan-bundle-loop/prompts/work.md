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
Size the slices before enumerating them (see **Slice sizing** above), then enumerate the impl-slices in the
`## Impl-slices` block under **Machine-read plan blocks** above.

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
(reviewed by `tracer-slicer`), in the shape under **Machine-read plan blocks** above.

A single-ticket plan omits the classification line. Approving an epic plan fans it out, confirm-first, into the
stacked sub-ticket chain and turns the epic into a tracking issue (§27.10 / §28.7).
