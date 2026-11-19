# Bundled flows

One page per flow in [`example/flows/`](../../example/flows), each with its diagram and what each of its loops does:

- [`feature-dev-v3`](feature-dev-v3.md), the full test-driven chain, with the [RED completion check](feature-dev-v3.md#red-completion-check).
- [`simple-dev-v1`](simple-dev-v1.md), a lighter chain for a ticket that fits one impl-slice.
- [`plan-only`](plan-only.md), which grooms a ticket and produces a reviewed plan.

The loops run in only 4 ways, and [How each loop runs](loops.md) draws each way once for all 3 flows.

## How to read the flow diagrams

Each box carries the step name the rail shows, the loop that step runs under it, and what that loop does. The rail also brackets every flow with **Not started** and **Completed**, and the diagrams start and end there too.

- A hexagon is a step with a `human` gate, where you decide. A rectangle is an `auto` step, which the engine approves when it finishes clean and hands to you when it doesn't ([spec §27.9.1](../spec/27-in-terminal-loop-engine-the-live-design.md)). A slanted box is a `manual` step, which moves on when you press **Advance**. A diamond is a check the engine makes at a gate, and a box with double side bars is an action the engine runs that ends the run.
- Solid arrows are approvals. Dotted arrows are the `back-to-red` gate option, the **Back to red** button (**Back to dev** in simple-dev-v1), which reopens the current slice ([spec §28.4.2](../spec/28-the-full-tdd-development-process-a-chain-of-loops.md)).
- Every loop step's gate also offers `redo`, which reruns that step's work, and some offer `polish` or `request-changes`. None of these moves the flow, so the diagrams leave them out. The table under each diagram lists every gate option and what approving the step does.
- Once the run has its branch and draft PR, every commit an approval makes is also pushed to the PR.

## How to read the loop tables

The **What each loop does** table on each flow page says which way each step's loop runs, what its work turn does and writes, which reviewers check it, and what ends it.

- **Runs as** links to the diagram in [How each loop runs](loops.md) for that way of running.
- **Reviewers** leave off the `review-plan-` and `impl-review-` prefix the rail shows.
- **Done when** is the goal a goal loop works to, what ends the step for a single work turn, or the verdict that ends a review-round loop. [How each loop runs](loops.md) says what the engine itself checks.

## Keeping these pages current

The step and loop definitions live in [`example/flows/`](../../example/flows) and [`example/loops-v2/`](../../example/loops-v2). When you change one, or the engine code in `src/` behind a note here, update its diagram and its rows in the step table and the loop table on that flow's page. When the engine changes how a loop runs, or a loop gains or loses a goal, a checkpoint, a `completion`, a `frozen_check`, reviewers or a consolidator, update [How each loop runs](loops.md) and the notes on each flow page. When the engine code behind the RED gate changes (starting from `redAsyncGate` and the `red` case of `completionShortfall` in `src/main/appLoopEngine.ts`), or this repository's `scripts/red-check.mjs`, `scripts/red-check-reporter.mjs`, `scripts/e2e-podman.sh`, `e2e/entrypoint.sh` or `loop-capabilities.yaml` changes, update the [RED completion check](feature-dev-v3.md#red-completion-check). Update the chain diagram in [spec §28.2](../spec/28-the-full-tdd-development-process-a-chain-of-loops.md) and the bundled flows table in the [README](../../README.md#bundled-flows) where they cover the change.
