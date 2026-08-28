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
