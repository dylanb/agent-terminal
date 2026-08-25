**Round 14 review — all four findings addressed:**

- **`frozenTests.ts:120` (ls-tree mode)** — fixed in 8f8ebad (see the thread): require a regular-file blob.
- **`frozenTests.ts:64` (suppressed — non-commit baseline)** — fixed in 8f8ebad. `changedTestPaths` peels both diff operands to `^{commit}`, so a bare tree/blob object id rejects (fail toward firing) instead of diffing. RED: a tree-sha baseline used to resolve `['tests/a.test.ts']`.
- **`phaseOutcome.test.ts:33` (suppressed — literal `raw`)** — fixed in 8f8ebad. `raw` is now typed `string`, so the compile-gate actually verifies `isPhaseOutcome` narrows `string → PhaseOutcome`.
- **`loopCapabilities.ts:30` (suppressed — descriptor not in src/shared)** — fixed in 4fd585e. Confirmed #105 mandates the descriptor in `src/shared` (single-sourced writer↔reader). Moved the shape, the serialized key vocabulary, and the parse predicate to `src/shared/loopCapabilities.ts` (renderer-safe — no `node:fs`; `TextEncoder`, not `Buffer`); the filesystem read stays in main, which re-exports the descriptor. A future recipe/prompt writer can now consume the same contract from shared. Behavior-preserving; the parser tests moved with it.
