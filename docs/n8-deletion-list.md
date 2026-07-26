# N8 sweep — the agreed deletion list

The artifact §27.15 and issue #98 require: the sweep is **reviewed with the operator, not decided
unilaterally**, and the agreed list is carried into the PR because ACs 2, 3 and 7 are graded against it.

**Baseline measured 2026-07-26 on `plan-loop/issue-98`:** `grep -rl '§26' src tests` → **119 files**;
`grep -ro '§26' src tests` → **1006 occurrences**.

## How to read this

Every file below carries exactly one class:

| class | meaning | graded under |
|---|---|---|
| **Delete whole** | exists only to implement §26; goes with its tests | AC 1 |
| **Split** | a surviving module holding §26-only code; it loses that code and keeps the rest | AC 2 / AC 3 / AC 9 / AC 10 |
| **Scrub** | the file's only §26 content **is** a citation; the edit touches comments, doc-comments, test names and prose only, and changes no behavior | AC 3 |

Two clauses of AC 1 are **not** visible to the grep and are listed separately:

- **§I — touched with zero §26 citations.** `grep -c '§26'` returns 0 for these, so the grep is not the
  evidence. Three kinds: a module orphaned when its last production importer goes (§I.1, the orphan walk
  is the evidence); a *surviving* file that nonetheless carries retiring surface (§I.2, found only by
  asking which files reference what §B retires); and a dead export on a surviving module (§I.3).
- **§H — deliberately retained.** Surface that survives *because a §27 path or an on-disk document
  depends on it*, each with a justification that does not rest on a citation, and a behavioural pin.

**Ownership decides the class, not location and not the header.** A §26 header is evidence, never proof:
`loopOrchestrator.ts` and `turnDoneFile.ts` both sit behind §26.3 headers and both are imported by the
§27 engine, so both are Split. `FlowLoopView` reads as the retired mirror and is in fact the surviving
engine-neutral contract.

## Method

The list was assembled **per source root** (`src/main`, `src/shared`, `src/renderer`, `src/preload`) and
**iterated to a fixpoint**: after each delete-whole round the consumer question was re-asked, because a
module orphans only once its last *production* importer goes. **A module's own tests never count as the
consumer that keeps it alive.** The walk starts from the three real entry points — `src/main/index.ts`,
`src/preload/index.ts`, `src/renderer/src/index.ts` — plus the two modules `electron.vite.config.ts`
imports at build time (`appIconBuild.ts`, `exampleAssetsBuild.ts`).

The fixpoint found **four** files the grep cannot see as orphans (§I.1) and **seven** more that survive
while carrying retiring surface (§I.2). Neither the type-check nor the build can fail on an orphan: both
`tsconfig`s include their roots wholesale and the bundler simply omits an unreferenced module. That is why
AC 1's no-orphan clause gets its own suite-level assertion rather than riding on `pnpm run build`.

The same walk was run over `tests/` — every test file importing a symbol §A deletes — because that is the
only way to find a test whose **subject survives** but whose **fixtures do not**. It found
`tests/integration/loopNotifier.test.ts`, which cites §26 zero times (§I.2).

---

# A. Delete whole — `src/`

## A.1 `src/main` — the retired engine's machinery

| file | §26 | what it is |
|---|---:|---|
| `agentLoopBridge.ts` | 2 | §19.1 / §24.2.3 T2 — the read-only mirror of `.agent-loop/state.yaml`. Scope item 1: support for externally-driven `agent-loop` runs ends here. |
| `loopDef.ts` | 41 | The §26 LoopDef parser and its tier resolver, including `loopExecAllowed` (origin-gated execute authority) and `gateForStatus`. |
| `loopStateWriter.ts` | 22 | The `.agent-loop/state.yaml` v4 whole-document writer (§26.6). |
| `loopStateReader.ts` | 10 | The engine-extension read-back of the same file (§26.6). |
| `loopOrchestrator.ts` → **see B.1** | 27 | **Not deleted whole** — Split; the §27 engine imports its turn runner. |
| `loopRecipe.ts` | 12 | §26.5/§26.3 actor-turn prompt composition from the retired def's `prompts/` templates. |
| `loopPickup.ts` | 10 | §26.9 / L1 in-app pickup ending in the initial `state.yaml` write. |
| `loopResume.ts` | 7 | §26.11 / L8 auto-resume + errored-turn reconstruction. |
| `loopRebind.ts` | 4 | §26 D42a resume-into-a-new-loop rebind. |
| `gateActions.ts` | 14 | §26.6 / L5 / D52 — the pure gate-outcome decision over the retired def's `on_*` action lists. |
| `gateExecutor.ts` | 18 | §26.6 / L5 / D52 — the imperative side (state write, gh side-effects, human note, re-iterate). |
| `gateExec.ts` | 3 | §26.6 — the `exec` gate action and its argv interpolation. Carries origin-gated execute authority. |
| `gateGithub.ts` | 3 | §26.6 / D53 — out-of-band gh side-effects for gate transitions. |
| `humanNotes.ts` | 1 | §26.6 — the `append-human-note` gate action's writer into `.agent-loop/human-notes/`. Its only wiring is the gate executor's port (`index.ts:1372`); §27 persists a request-changes reason on its own run-state (`AppLoopRunState.feedback`, N5), not here. |
| `reviewArtifacts.ts` | 11 | §26.4 / D47a(b) — per-persona review JSON presence + the merge surface. Superseded by the §27 round report (N3). |
| `personaSkip.ts` | 5 | §26.5/§26.13 L6 — the fan-out skip-optimization and `persona_state` footprints. Superseded by the consolidator's roster (N4). |
| `findingSignature.ts` | 5 | §26.8 — the SHA256 stuck detector. Superseded by the consolidator's `stop for a human` (N4). |
| `costMeter.ts` | 6 | §26.10 — session-JSONL token recovery for the cost meter. |
| `ciChecks.ts` | 4 | §26.7 / D54 / L8 — the run-don't-block CI snapshot. |
| `epicPlan.ts` | 3 | §26.9 / L8 — epic classification of `plan.md`, feeding epic-promote. |

## A.2 `src/shared`

| file | §26 | what it is |
|---|---:|---|
| `pricing.ts` | 7 | §26.10 model→dollar pricing. Its two consumers are the deleted `costMeter.ts` and the status strip's cost readout, which goes with it (AC 9). The §25 audit's `loop.cost` union member carries a plain `usd: number` and does **not** import this module — see §H.1. |

## A.3 Vendored def snapshot and its bundled skills

| path | what it is |
|---|---|
| `example/loops/` (whole tree: `impl-loop/`, `plan-loop/`, their `charter/`, `prompts/`, `skills/`) | The committed snapshot of the retired-schema defs (§26.5) and the reviewer-persona skills the install action offered. `example/loops-v2/` is the surviving tree and is untouched. |

Contains the one §26 citation outside `src`/`tests`/`docs` that is deleted rather than disposed of:
`example/loops/plan-loop/plan-loop.yaml:196`.

## A.4 Tests deleted because their subject is deleted

Every entry names the subject from §A whose deletion accounts for it (AC 2).

| test file | §26 | subject |
|---|---:|---|
| `tests/unit/loopResume.test.ts` | 8 | `loopResume.ts` |
| `tests/unit/findingSignature.test.ts` | 7 | `findingSignature.ts` |
| `tests/unit/loopRebind.test.ts` | 5 | `loopRebind.ts` |
| `tests/unit/personaSkip.test.ts` | 2 | `personaSkip.ts` |
| `tests/unit/epicPlan.test.ts` | 2 | `epicPlan.ts` |
| `tests/unit/ciChecks.test.ts` | 3 | `ciChecks.ts` |
| `tests/unit/pricing.test.ts` | 3 | `src/shared/pricing.ts` |
| `tests/unit/gateExec.test.ts` | 2 | `gateExec.ts` |
| `tests/integration/humanNotes.test.ts` | 2 | `humanNotes.ts` |
| `tests/unit/exampleSkills.test.ts` | 1 | `exampleSkills.ts` (§I) |
| `tests/integration/loopDef.test.ts` | 15 | `loopDef.ts` |
| `tests/integration/loopStateWriter.test.ts` | 21 | `loopStateWriter.ts` |
| `tests/integration/loopStateReader.test.ts` | 11 | `loopStateReader.ts` |
| `tests/integration/gateActions.test.ts` | 12 | `gateActions.ts` |
| `tests/unit/gateExecutor.test.ts` | 12 | `gateExecutor.ts` |
| `tests/integration/reviewArtifacts.test.ts` | 10 | `reviewArtifacts.ts` |
| `tests/integration/loopRecipe.test.ts` | 9 | `loopRecipe.ts` |
| `tests/integration/loopPickup.test.ts` | 8 | `loopPickup.ts` + `legacyPickupPorts.ts` |
| `tests/integration/costMeter.test.ts` | 6 | `costMeter.ts` |
| `tests/integration/loopExecConfig.test.ts` | 5 | `loopDef.ts`'s `loopExecAllowed` + `gateExec.ts` |
| `tests/integration/agentLoopBridge.test.ts` | 3 | `agentLoopBridge.ts` |
| `tests/unit/agentLoopBridge.test.ts` | 0 | `agentLoopBridge.ts` — **invisible to the grep** |
| `tests/helpers/loopGate.ts` | 1 | **Split** — the helper builds `FlowLoopView` fixtures, which survive. Scrub + drop the §26-only fixture shape. |

**No surviving subject loses its test, and no surviving assertion is weakened.** Where a test file mixes
§26 and §27 subjects it is listed in §D as a Split, never deleted.

---

# B. Split — `src/` (a surviving module loses only its §26-only code)

## B.1 `src/main/loopOrchestrator.ts` (27) — the sharpest case

The §27 engine imports `createTurnRunner`, `TurnRunner` and `HostedAgentState` from this module
(`appLoopEngine.ts:20`), and `index.ts` imports `classifyHostedAgent` / `hostedAgentPresent` for the
§27 wiring.

- **Goes:** `ConsolidateOutcome`, `ConsolidateInputs`, `decideConsolidateOutcome` — the §26.6 consolidate
  verdict routing (clean/needs-work → gate, iterate, or the retired triage/cap branch). Its only
  production consumer is `index.ts`'s §26 chain.
- **Stays:** `TurnState`, `HostedAgentState`, `TurnRunnerDeps`, `TurnRunner`, `createTurnRunner`,
  `hostedAgentPresent`, `classifyHostedAgent`. Header re-pointed at §27.

## B.2 `src/main/turnDoneFile.ts` (5)

- **Goes:** the `AGENT_LOOP_TURN_DONE_SUBDIR = '.agent-loop'` default and its defaulted parameter — after
  the sweep every caller is §27 and passes its own area.
- **Stays:** `readTurnDone` / `clearTurnDone` / the watcher, with `subDir` **required**. §27's
  `appLoopEngine.ts` already passes `APP_LOOP_DIR_SEGMENTS`.

## B.3 `src/main/flow.ts` (21)

- **Goes:** `import type { AgentLoopState }` and `import { gateForStatus, type LoopDef }`; the
  `FlowReadLoop` / `FlowReadLoopDef` ports and their `readLoopState` / `readLoopDef` deps; the
  `legacyLoopName` selector (the §26 gate-decision write half's engine selector); the `cost` readout
  member and the `startedAt` stamping that fed the cost meter's sweep window (AC 9 — the readout goes).
  `classifyHumanNeeded`'s gate-driven branch collapses to the shared `isHumanNeededStatus` predicate.
- **Stays:** everything else, including `FlowLoopView` production and the whole flow state machine.
- **Changes (AC 4, new behavior, own tests):** `loop_namespace` parsing — absence resolves to the
  surviving engine; `legacy` parses and marks the binding as **naming no surviving engine**; every other
  value keeps today's whole-file rejection; the loop **name** guard becomes unconditional at load; and the
  local-first fallback stops re-reading the absent local file when a present-but-invalid global one fails,
  so a bad value is no longer reported as a missing flow.

## B.4 `src/shared/loopNamespace.ts` (3)

- **Goes:** the `legacy` member of the closed set, and "absence means §26".
- **Stays / changes:** the closed set narrows to one member; absence resolves to it; a new
  **"names no surviving engine"** classification is added for the `legacy` literal, written by the loader
  and read by all three seams. **Selection becomes an affirmative test against the surviving member**, never
  the negation of the deleted one, so a marked binding is unbindable by construction.
  One definition, both sides (CLAUDE.md shared-semantics).

## B.5 `src/main/flowEntryActions.ts` (10)

- **Goes:** the `runPickup` / `resumeLoop` §26 ports and the §26 branch of the dispatcher.
- **Changes (AC 10, new behavior, own tests):** the engine dispatch moves **below** `skill` injection and
  `bootstrap` setup, so a namespace-less step keeps both. `skill` is injected first under its existing
  busy-shell refusal; `bootstrap: pickup` is satisfied by the surviving engine's own bootstrap contract,
  and a step declaring it whose bound def carries **no** such contract does not run and surfaces why, with
  a route out.

## B.6 `src/main/loopDefV2.ts` (1) + a new AC 5 migration path

- `loopDefV2.ts` (1): scrub the "independent of the §26 parser" header sentence.
- **AC 5 lands here** (or in a sibling module the resolver owns): where the surviving operator tier
  answers nothing for a name, **detect the retired tier's presence** — no content read, nothing parsed,
  moved, modified or deleted — then **write the app's own copy into the surviving tier** and raise a
  one-shot notice. Where **no** tier answers at all, the retired tier's presence turns a bare
  "no def named X" into a surfaced reason naming the retired schema.
  Both filesystem touches sit on ground the user owns → `resolveOwnedDirJail` + `confinedRealPath`
  (CLAUDE.md path-confinement rule); a config root the app declines to resolve yields **no** probe and
  **no** write; the write is additive-only. The retired tier's directory name resolves through
  `userConfigLoopsDir` (§H.4), never a bare literal.

## B.7 `src/shared/ipc.ts` (32)

Every §27 widening was additive, so what goes is the surface only the retired engine produced or consumed.

- **Goes:** `FlowLoopView.cost` (with its only producer — AC 9); `flow:gateDecision` and its
  `GateDecisionRequest` (the §26 decision channel); `flow:markTurnComplete` and `flow:retryTurn`; the
  `loops` and `skills` members of `INSTALL_DESTINATION_IDS`.
  **Checked, not assumed:** the §27 route-out is a *separate* channel — `loopPanel.ts:178` gates its
  three affordances on `loop.appTurn` and dispatches `appRouteOut('retry'|'accept'|'terminate')`, while
  `loopPanel.ts:158` gates `retryTurn` on `loop.iteration !== undefined` and `:552` renders
  `markTurnComplete` unconditionally on service presence. Both are wired only from the §26 chain
  (`index.ts:615`, `:1500`). `flow:appGateDecision` survives and already carries the target identity §6
  requires; `flow:gateDecision` carries none, which is why it cannot be the survivor.
- **Stays:** everything else. `FlowLoopView` is the engine-neutral contract both engines implemented and
  is **not** the mirror despite its §24.2.3 T2 doc comment — that comment is **rewritten** to describe what
  §27 provides (AC 9: no surface still labels the loop view as a mirror of a file the app no longer reads).
- **AC 5's notice rides the existing one-shot transient-notice field** rather than widening the contract.

## B.8 `src/main/ipcValidation.ts` (3)

- **Goes:** the `flow:gateDecision` validator and the §26 gate-option set, in lockstep with B.7.
- **Stays:** every §27 validator; `flow:resolveBootstrapConflict`'s citation is re-pointed at §27.10.

## B.9 `src/renderer/src/loopPanel.ts` (16) — **Split, not Scrub**

Its labels are text an operator reads, so AC 3's behavior-preserving rule does not cover it (AC 9).

- **Goes:** the `gateDecision` service and the §26 decision-button branch (`appTurn`-presence routing
  collapses to one path); the `State · .agent-loop/state.yaml (v4)` labelling.
- **Stays:** the gate-options row, the error/reason row, the retry affordance, the live region.
- **Graded under AC 2 / AC 9 with its own component test + the `@relocatable` organism test**
  (UI-STANDARDS: organisms get a per-component test, an e2e, and a relocation test).
  Accessible names change → WCAG 4.1.2 (name/role/value) re-checked; focus order unchanged (2.4.3).

## B.10 `src/renderer/src/flowStrip.ts` (3) — **Split, not Scrub**

- **Goes:** the §26.10 cost node — both its value and its **structural presence** (AC 9: no surface may be
  left asserting the strip carries a running cost), and the `formatCost` import from the deleted
  `pricing.ts`.
- **Stays:** the activity phrase + spinner, iteration, verdict.
- WCAG 4.1.2 re-checked for the removed node's accessible name; contrast (1.4.3) unaffected.

## B.11 `src/main/installExamples.ts` (4) + `src/main/exampleAssets.ts` (2) + `src/main/exampleAssetsBuild.ts` (1)

- **Goes:** the `loops` and `skills` destination specs (both source from `resolveExampleLoopsDir`);
  `resolveExampleLoopsDir` itself; `copyExampleLoops`; the build-time skill-name-collision guard.
- **Stays:** `flow`, `appLoops`, `commands`. The surviving defs carry charters **by reference**, so no §27
  path depends on the skills tree.
- **AC 9:** both are user-visible entries in the install report — recorded as removed capabilities.

## B.12 `src/main/userConfig.ts` (3)

- **Goes:** `userConfigSkillsDir` (dead once the `skills` destination goes); the "the origin §26.6 grants
  `exec` authority on" sentence.
- **Stays:** `userConfigLoopsDir` — **retained deliberately** as AC 5's presence-check anchor (§H.4);
  `userConfigLoopsV2Dir`, `userConfigCommandsDir`, the root resolver.

## B.13 `src/main/appBootstrapCommand.ts` (0 §26)

- **Goes:** `runLegacy` — dead once `legacyPickupPorts.ts` goes (**invisible to the grep**; §I).
- **Stays:** `run`, `CommandFailure`.

## B.14 `src/main/auditRecorder.ts` (2) + `src/shared/audit.ts` (5) — writer half only

- **Goes:** `recordCost` / `recordCi` and the `loop.cost` / `loop.ci` **emitters**, with their
  `CostResult` / `CiSnapshot` imports.
- **Stays:** the `loop.cost` and `loop.ci` **union members** and the reader's fold of them — see §H.1.

## B.15 `src/main/index.ts` (92) — the composition root

The largest edit. Loses every §26 wiring: the bridge watcher, the def resolver, the state reader/writer,
the turn chain (work → fan-out → consolidate), the gate executor and its ports, resume/rebind,
cost/CI recording, epic-promote, pickup. Keeps every §27 wiring untouched, and gains AC 10's entry-action
ordering and AC 4's marked-binding error at each of the three seams.

## B.16 `src/main/appLoopEngine.ts` (5), `loopViewV2.ts` (2), `appGateDecision.ts` (7), `appLoopState.ts` (1)

Surviving §27 modules whose §26 content is entirely explanatory ("reads no §26 loop state", "never reaches
the §26 executor"). **Classified Scrub** — see §C. Listed here only because a reader scanning for the §27
engine will look for them.

## B.17 `src/shared/loopTurn.ts` (4) — **Split, not Scrub**

- **Goes:** `AGENT_LOOP_DONE_REL_PATH` (`.agent-loop/turn-done`) and its use as the **default parameter** of
  `doneSignalInstruction`. `doneRelPath` becomes **required**.
- **Stays:** `TURN_DONE_FILENAME`, `doneSignalInstruction` and its artifact-verification block.
- **Checked:** every §27 caller already passes the path explicitly — `appWorkTurn.ts:93`,
  `reviewTurn.ts:109`, `consolidateTurn.ts:75`. The only caller relying on the default is the deleted
  `loopRecipe.ts` (`:52`, `:139`).

## B.18 `src/main/flowState.ts` (2) — the persisted document

- **Goes:** nothing from `PERSISTED_KEYS`.
- **Stays:** `started_at` / `startedAt` and `readStartedAt`. The decoder **rejects any key outside a fixed
  set**, so dropping this member would make every flow-state document the app has already written fail to
  decode — silently discarding the operator's in-progress position and every resolved typed input. The
  format carries no version and is never migrated. See §H.2; the doc-comment is rewritten to say this
  rather than to cite §26.10.

---

# C. Scrub only — the file's sole §26 content is a citation

Comments, doc-comments, test names and prose. **No exported surface, control flow, or observable behavior
changes.** A file whose behavior must change is not here — it is in §B.

**`src/main`:** `appGateDecision.ts` (7), `appLoopEngine.ts` (5), `shadow.ts` (2), `runtimeConfig.ts` (1),
`shellIntegration.ts` (1), `appStateDirs.ts` (1 — the comment is rewritten to name the *surviving*
bootstrap's clean-tree gate; the array's membership is unchanged, §H.3), `appLoopState.ts` (1),
`loopDefV2.ts` (1), `loopViewV2.ts` (2), `exampleSkills.ts` → **deleted, see §I**.

**`src/shared`:** `loopGate.ts` (2), `loopStatus.ts` (1), `loopActivity.ts` (1).
`loopTurn.ts` (4) was initially filed here and **re-classified Split** on inspection — see §B.17. It is the
worked example of why a §26 header is evidence and not proof, in the direction AC 3 forbids: its §26
content is a live exported constant, not a citation, so scrubbing it would have changed behavior.

**`src/renderer`:** `confirmDialog.ts` (3), `spinner.ts` (1), `installExamples.ts` (1),
`flowInputModal.ts` (1 — the helper text names `bootstrap`; re-pointed at §27.10, and its wording is
re-checked against AC 10), `errorDialog.ts` (1), `wireBootstrapConflict.ts` (1), `styles.css` (2),
`index.html` (1).

**`tests/`:** `unit/shadow.test.ts`-class files — see §D.3.

---

# D. Tests

## D.1 Deleted — subject deleted

See §A.4. Every entry names its subject.

## D.2 Split — the file mixes a deleted subject with a surviving one

| test file | §26 | goes | stays / changes |
|---|---:|---|---|
| `tests/unit/loopOrchestrator.test.ts` | 26 | the `decideConsolidateOutcome` block | the turn-runner behavior §27 depends on |
| `tests/unit/flowLoopNamespace.test.ts` | 15 | the "absence selects §26" pins | **rewritten to AC 4's three cases** + the reason-accuracy rule, incl. the global-home negative |
| `tests/unit/loopPanel.test.ts` | 13 | the §26 decision-service and mirror-label assertions | every surviving panel behavior; **new** AC 9 label assertions |
| `tests/unit/flowEntryActions.test.ts` | 10 | the §26 pickup/resume port assertions | **new** AC 10 assertions on a namespace-less step |
| `tests/unit/loopTurn.test.ts` | 9 | the `.agent-loop` default-subdir pins | the done-signal contract |
| `tests/integration/turnDoneFile.test.ts` | 5 | the defaulted-subdir pins | read/clear/watch behavior |
| `tests/unit/loopNamespace.test.ts` | 4 | the two-member set | the narrowed set + the "names no surviving engine" classification |
| `tests/unit/audit.test.ts` | 4 | the cost/CI **emitter** tests | the **reader** fold of `loop.cost` / `loop.ci` — retitled as historical-record tolerance (§H.1), **kept and strengthened** |
| `tests/unit/flowMachine.test.ts` | 4 | §26 loop-state wiring | flow machine behavior |
| `tests/unit/flowLoop.test.ts` | 4 | §26 provider paths | §27 provider paths |
| `tests/integration/installExamples.test.ts` | 4 | `loops` / `skills` destination assertions | `flow` / `appLoops` / `commands` |
| `tests/unit/installDestinations.test.ts` | 1 | `loops` / `skills` target pins | the narrowed id set |
| `tests/unit/userConfig.test.ts` | 0 | `userConfigSkillsDir` pins | `userConfigLoopsDir` pin **kept** (§H.4) |
| `tests/unit/exampleAssets.test.ts` | 3 | `resolveExampleLoopsDir` pins | `resolveExampleLoopsV2Dir` / flow / commands |
| `tests/unit/exampleAssetsBuild.test.ts` | 2 | `copyExampleLoops` + collision-guard pins | the surviving copies |
| `tests/unit/ipcValidation.test.ts` | 3 | `flow:gateDecision` validator tests | every §27 validator |
| `tests/unit/flowStrip.test.ts` | 2 | the cost-node presence test | the strip's surviving nodes |
| `tests/integration/flowState.test.ts` | 1 | — | **strengthened**: a document written by the pre-sweep app still decodes with progression + inputs intact (§H.2) |
| `tests/integration/appBootstrapCommand.test.ts` | 3 | the `runLegacy` tests (§I.3) | the `run` / `CommandFailure` tests |
| `tests/helpers/loopGate.ts` | 1 | its `parseLoopDef` import and the §26-only fixture shape | the `FlowLoopView` fixture builders, which survive |
| `tests/e2e/app.spec.ts` | 129 | the §26 e2e block (pickup/conflict, gate approve/request-changes/impasse, cap + triage, skip-opt, stuck signature, epic-promote, cost, CI, resume/rebind, sentinel/turn-done §26 variants) — ~30 tests | every §27 test; the shared fake-agent/PTY harness; **new**: the six tracer-bullet assertions of AC 6 |

Two `app.spec.ts` tests are **narrowed, not deleted**, and are called out because deleting either would be
an AC 2 defect:

- *"installing the bundled examples seeds the flow, app and legacy loop definitions, skills and commands"* —
  its subject (the install action) survives; the assertion narrows to flow + app + commands.
- *"a legacy (§26) loop step still runs the §26 work path unchanged, writing no §27 loop state"* — this one
  **is** deleted, and is the one test whose deletion the sweep *inverts* rather than removes: AC 4's
  `legacy` case replaces it, asserting the step now surfaces a per-step failure with a route out.

## D.3 Scrub only

`tests/integration/shadow.test.ts` (5), `tests/unit/loopActivity.test.ts` (4),
`tests/unit/confirmDialog.test.ts` (3), `tests/integration/appGateDecision.test.ts` (3),
`tests/unit/wireBootstrapConflict.test.ts` (2),
`tests/unit/spinner.test.ts` (2), `tests/unit/githubUrl.test.ts` (2 — `numberFromGithubUrl` survives via
`appGateGithub.ts`), `tests/unit/flowInputModal.test.ts` (2), `tests/unit/errorDialog.test.ts` (2),
`tests/unit/appWorkTurn.test.ts` (2), `tests/integration/loopDefV2.test.ts` (2),
`tests/integration/auditRecorder.test.ts` (2), `tests/integration/appLoopEngine.test.ts` (2),
`tests/unit/runtimeConfig.test.ts` (1), `tests/unit/modalShell.test.ts` (1),
`tests/unit/loopStatusShared.test.ts` (1), `tests/unit/installExamplesView.test.ts` (1),
`tests/integration/loopViewV2.test.ts` (1), `tests/integration/appLoopState.test.ts` (1).

`tests/integration/appBootstrapCommand.test.ts` and `tests/helpers/loopGate.ts` were initially filed here
and **re-classified Split** on inspection (§D.2): each imports a deleted symbol, so the edit is not
confined to prose.

## D.4 New tests (RED first)

| RED test | AC |
|---|---|
| citation grep over `src` + `tests` returns zero | 1 |
| orphan walk from the three entry points, test files counted as non-consumers | 1 |
| the narrowed namespace vocabulary; absence → surviving engine; `legacy` → marked; any other value → whole-file rejection; the classification helpers agree | 4 |
| each of the three seams yields a human-needed error for a marked binding, with a route out, while the rest of the flow advances / undoes / reverts / terminates | 4 |
| a misspelled namespace and an unsafe loop **name** fail the whole load, reason names the real cause — **including from the operator's global home** | 4 |
| the migration write into the surviving tier; the notice fires **exactly once**; the step still runs; the retired def is never read/parsed/moved/deleted. **RED removes the user-config root first** | 5 |
| both-tiers-answer → the surviving def wins (the recorded AC 9 substitution) | 5 / 9 |
| no-tier-answers + retired tier present → surfaced reason naming the retired schema | 5 |
| a symlink at either tier's entry makes neither the probe fire nor the write escape; an unresolvable config root suppresses both | 5 |
| a namespace-less step's `skill` is injected (busy-shell refusal honoured) and its `bootstrap: pickup` sets up the branch; a declared `bootstrap` with no contract on the bound def does not run and surfaces why | 10 |
| loop panel + status strip carry no mirror label and no cost readout | 2 / 9 |
| a repo dirty **only** under `.agent-loop/` still passes the surviving bootstrap's clean-tree gate | 2 (§H.3) |
| an audit stream carrying `loop.cost` / `loop.ci` still reconstructs a whole timeline | 2 (§H.1) |
| a pre-sweep flow-state document decodes through both read paths, progression + inputs intact | 2 (§H.2) |
| the six AC 6 tracer-bullet e2e assertions — the (c) fixture carries **only** the retired tier | 6 |

---

# E. AC 7 — every surviving §26 citation outside `src/` and `tests/`, with its disposition

AC 1's grep does not reach here, so this table **is** the evidence.

## E.1 Deleted

| path | note |
|---|---|
| `docs/spec/26-in-terminal-loop-engine-v2-99-retired-superseded-by-section-27.md` | the section file (25 self-citations go with it) |
| the §26 row of the spec table of contents | in `terminal-web-ui-spec.md` |
| `example/loops/plan-loop/plan-loop.yaml:196` | goes with §A.3 |

## E.2 Rewritten to what ships (present-tense content changes)

| path:line | what changes |
|---|---|
| `terminal-web-ui-spec.md:4` | the document-status / **Scope** paragraph — three claims become false at once: §26 is "retired-but-running", §27 "is built alongside it", and the sweep is "pending". Rewritten to what ships. |
| `docs/spec/18-flow-definitions-flow-yaml.md:94` | the flow-step schema's own account of `loop_namespace`'s legal values and its absence default (AC 4). |
| `docs/spec/18-flow-definitions-flow-yaml.md:101` | §18.3's account of `bootstrap` (AC 10) — no longer "runs `agent-loop pickup` for a legacy-bound step". |
| `docs/spec/18-flow-definitions-flow-yaml.md:10` | the skills fan-in — the reviewer-persona skills destination is gone (AC 9). |
| `docs/spec/18-flow-definitions-flow-yaml.md:16` | `loopExecAllowed` / origin-gated execute authority is gone (AC 9); the surviving schema still declares the capability, which is what the note must now say. |
| `docs/spec/22-ui-shell-views-overlay-status-strip-layout.md:23` | "the §26 phrase + spinner" — re-pointed at §27.11, and **the strip's running-cost claim is corrected** (AC 9: no spec section may be left asserting it). |
| `docs/spec/27-…:3` (status line) | "This is the live loop design; **§26 is retired but still running**" → false. |
| `docs/spec/27-…:11` | "On any conflict with §17–**§26**, this section wins" — the range's upper bound no longer exists. |
| `docs/spec/27-…:231` (§27.14 preamble) | "still in the tree, still specified by §26, and still runs, **until** the N8 sweep deletes it… Code implementing the left column is therefore not a review finding **while §26 stands**" → every clause false. The **map itself (the table) stands as history.** |
| `docs/spec/27-…:262` | "The old engine is **never modified, only routed around** … until N8 deletes it whole" → false. |
| `docs/spec/27-…:263` | "N8 **is** a big-bang deletion" (future tense) **and its burn-down-test sentence** — the burn-down test was never built (ticket non-goal), so this is the one line that is neither history nor re-pointable; it is rewritten to say the grep is the evidence and no burn-down test existed. |
| `docs/spec/27-…:302` (the N8 build-phase bullet) | states the sweep as future work, and names only §8.3/§15.6 as the live cross-references — an undercount this list corrects (§E.3). |
| `docs/spec/27-…:24` | the parenthetical "*§15.6 and §8.3 **currently** cross-reference [this] as §26.2; those refs **are re-pointed** to §27.2 at N8*" — present tense plus a future promise, both false once E.3 lands. Rewritten or dropped; it says nothing the re-pointed citations do not. |

**§27 citations that stand as history, checked line by line:** `:5` (why a new section number), `:229`
(the map is "larger than §26's"), `:258` and `:261` (the coexistence bargain and its accepted cost),
`:267`, `:268`, `:270`, `:272`, `:273`, `:279` (N1's and N3's departures — dated changelog blocks),
`:282`, `:285` (N5's), `:294`, `:295`, `:299`, `:301` (build-phase records of what each slice did).
A history note may cite a deleted section (AC 7).

That is **16** of §27's 23 citations standing as history and **7 rewritten** — the split the operator should
sanity-check first, because §27's own account of the engine it replaced is exactly where "leave as history"
and "rewrite the present-tense claim" sit one line apart.
| `docs/spec/04-architecture.md:39` and `:75` | the live §15.6/§26.2 hosted-agent-presence citations re-point at §27.2 (see E.3) — listed here only because line 75's prose also states what the tracker feeds **today**. |
| `CODE-STANDARDS.md:354` | "reviewable … by the §26 persona fan-out" — a present-tense claim about how review works now. |

## E.3 Re-pointed (the concept survives under §27, at its actual §27 home — not all one section)

| path:line | destination |
|---|---|
| `docs/spec/08-…:64` (`§26.2` — the injectable gate) | **§27.2** (as §27.2 itself already directs) |
| `docs/spec/08-…:92` | §27.2 |
| `docs/spec/04-architecture.md:39`, `:75` (`§15.6/§26.2`) | §27.2 |
| `CODE-STANDARDS.md:76`, `:88` (`cap_baseline`, §26.6/§26.8) | **the iteration cap is retired (§27.14)** — the *rule* (a persisted value feeding a safety limit is validated in two non-redundant places) survives; its worked example is re-anchored on a surviving §27 value, or the example is restated without a live citation. Adjudicate at implementation; recorded here so it is not silently dropped. |
| `CODE-STANDARDS.md:259` (bootstrap reverts the flow, §26.9) | §27.10 |
| `CODE-STANDARDS.md:260` (`error` status + retry, §26.3/D48) | §27.12 |
| `electron-builder.yml:19` (`§18.1/§23.4/§26.5`) | §18.1/§23.4/§27.8, **and** the `example/loops` entry is removed from the shipped files list (§A.3) |
| `design/shell/tokens.css:69` (`§26` loop-mechanics activity) | §27.11 |

## E.4 Left standing as history — not rewritten

- `docs/spec/changelog.md` — **every existing entry byte-for-byte** (AC 8). 13+ entries cite §26; they were
  true when written. **Exactly one new entry is added** recording §26's deletion, the `loop_namespace`
  absence re-point, and each capability §F names, with the version bump on `terminal-web-ui-spec.md`:
  **Draft v2.140 → v2.141** (current value read from `terminal-web-ui-spec.md:3`).
- `docs/spec/24-build-plan-ui-inwards.md:11` — the `Amended v2.132` note; describes what was true at a past
  version.
- `docs/spec/15-…:50` — the `Amended v2.132` note. **The worked both-cases example:** the historical framing
  stands, and the present-tense clause stating what the command tracker feeds **today** re-points (E.3).
- `docs/spec/27-…` §27.14's map, §27.15's coexistence record, and §27's rationale for taking a new section
  number — §27's own account of the engine it replaced. A history note may cite a deleted section.
- `design/new-loop-brief.md:104`, `:106`, `:107` — the design interview record; a dated artifact describing
  what was decided, not how the system works now.

**No surviving document describes current behavior by citing a section that no longer exists.**

---

# F. AC 9 — capabilities removed, recorded not discovered

1. **Epic-promote** (§26.9 / L8) — nothing replaces it until N9 (#93). No interim surface, no stub, no
   warning dialog (ticket non-goal).
2. **Support for externally-driven `agent-loop` runs** — the app no longer reads or writes
   `.agent-loop/state.yaml`. No surface still labels the loop view as a mirror of it.
3. **The running-cost readout** on the status strip and its per-iteration `loop.cost` events — no §27
   equivalent until N7 (#92). No spec section is left asserting the strip carries a running cost.
4. **The run-don't-block CI snapshot** and its `loop.ci` audit events.
5. **Origin-gated execute authority** — "only an operator-authored def may name a program to run". The
   surviving schema still declares the capability; no equivalent ships here.
6. **The operator def tier the retired engine read** — the app stops seeding it and stops resolving defs
   from it, retaining only AC 5's presence check, and leaves it in place on the operator's disk untouched.
7. **The silent substitution** — where both tiers answer for one name the surviving def wins and the
   retired one is ignored, unsurfaced; the app genuinely cannot tell a customised retired copy from the one
   its own install seeded.
8. **The reviewer-persona skills** the install action offered — their bundled source goes with the retired
   def tree; the surviving defs carry charters by reference.
9. **The `loops` and `skills` install destinations** — user-visible entries in the install report.
10. **The §26 gate-decision IPC channel** (`flow:gateDecision`) — `flow:appGateDecision` survives and
    carries the target identity §6 requires.

---

# G. Five changes invisible to AC 1's grep

AC 1 passing is evidence for **none** of these; each carries its own test (§D.4).

1. The `loop_namespace` **absence re-point** (AC 4).
2. `APP_STATE_DIRS` **membership** (§H.3).
3. The persisted flow-state **key set** (§H.2).
4. AC 5's **migration behavior**.
5. AC 10's **dispatch ordering**.

**A sixth, found while assembling this list and not named in the plan:** files that carry retiring surface
while citing §26 **zero times** — `src/preload/index.ts`, `src/renderer/src/index.ts`, and four test files
(§I.2). Neither the grep nor the orphan walk reaches them, because they survive and cite nothing. They are
found only by asking which files reference the surface §B retires. Recorded here so the omission reads as a
known fact rather than as coverage.

---

# H. Deliberately retained — justified without a citation, pinned behaviourally

## H.1 The §25 audit's `loop.cost` and `loop.ci` union members and the reader's fold of them

The on-disk audit format carries **no schema version and written records are never migrated**; §25.6's
contract is that a complete timeline is recoverable from the record alone. A stream written before the
sweep must still reconstruct whole. **Writer half only** is retired (§B.14).
**Pin:** an audit stream carrying both kinds reconstructs a whole timeline.

## H.2 `started_at` in the persisted flow-progression document

`PERSISTED_KEYS` is a **closed set and the decoder rejects any key outside it**. Dropping this member would
make every flow-state document the app has already written fail to decode — discarding the operator's
in-progress position and every resolved typed input. The format carries no version and is never migrated.
**Pin:** a pre-sweep document decodes through both read paths with progression and inputs intact.

## H.3 `.agent-loop` in `APP_STATE_DIRS`

Two readers: the artifact viewer's live-reload watch, and the **clean-tree predicate backing the surviving
engine's bootstrap gate** — the precondition checked immediately before a branch deletion. Dropping the
member would make every repo that has ever run the external engine judge dirty and refuse: an AC 2
regression on a destructive path.
**Pin:** a repo dirty only under `.agent-loop/` still passes the surviving bootstrap's clean-tree gate.

## H.4 `userConfigLoopsDir` and AC 5's presence check

**Indefinite retained surface, not deferred cleanup. It carries no removal TODO.** No slice owns removing
it — §27.15's N9–N11 are epic-promotion work — and the app can **never observe** an operator having
migrated off the retired tier, because it never reads that tier's contents. Its one lasting coupling is the
retired tier's directory name, which resolves through this existing resolver rather than a bare literal.
**Pin:** AC 5's behavioural tests (§D.4), including the negatives.

---

# I. Touched with **zero** §26 citations — invisible to AC 1's grep

## I.1 Deleted — the orphan walk is the evidence, not the grep

| file | orphaned by |
|---|---|
| `src/main/legacyPickupPorts.ts` | `loopPickup.ts` (its only importer) |
| `src/main/exampleSkills.ts` | the `skills` install destination + the build-time collision guard (its only two importers) |
| `tests/unit/agentLoopBridge.test.ts` | `agentLoopBridge.ts` |
| `tests/unit/exampleSkills.test.ts` | `exampleSkills.ts` |

## I.2 Split — surviving files with no §26 citation that nonetheless carry retiring surface

Neither the grep nor the orphan walk sees these: the file survives and cites nothing. They are found by
asking which files reference the surface §B retires.

| file | what goes |
|---|---|
| `src/preload/index.ts` | the `flowGateDecision`, `flowMarkTurnComplete` and `flowRetryTurn` bridge methods |
| `src/renderer/src/index.ts` | the `markTurnComplete` / `gateDecision` / `retryTurn` service wiring (`:187`–`:197`); the panel's `appRouteOut` + `appGateDecision` wiring stays |
| `tests/unit/preload.examples.test.ts` | the `'skills'` destination in its apply fixture |
| `tests/unit/destRelative.test.ts` | the retired skills-tree fixture path; `destRelative` itself survives |
| `tests/integration/installExamplesResolution.test.ts` | the `loops` / `skills` resolution assertions and its `parseLoopDef` import |
| `tests/browser/styleContrast.test.ts` | the `loops` / `skills` destinations in its install-report fixtures; **every WCAG assertion is unchanged** — only the fixture's destination ids narrow |
| **`tests/integration/loopNotifier.test.ts`** | see below — the sharpest AC 2 trap in the sweep |
| `src/main/artifactTree.ts` | the stale `TODO(agent-loop bridge, §24.2): LoopDef artifacts: declarations` at `:2` — it names a bridge and a def schema that both cease to exist. Removed (CLAUDE.md: no TODO without a live owner). |

**`tests/integration/loopNotifier.test.ts` is the one to get wrong.** It cites §26 **zero** times, so the
grep never names it; its subject `src/main/loopNotifier.ts` **survives** (§24.2.3 T4 is engine-neutral — it
observes a `FlowStateView` and knows nothing about either engine); and yet every one of its fixtures is
built through three deleted things — `parseAgentLoopState`, `parseLoopDef` and `deriveLoopView`
(`:5`–`:7`). Deleting the file would be an AC 2 defect ("a §27 test deleted while its subject survives");
so would relaxing an assertion to make the fixture simpler. **The fixtures are re-expressed on the
surviving §27 loop-view provider and every assertion is carried over unchanged.**

`tests/integration/confinedPath.test.ts` was checked and is **not** in this set: its `loops` path segment
(`:47`, `:62`) is a jail fixture name, unrelated to the install destination.

## I.3 Dead exports on surviving modules

Not orphan modules, so neither the walk nor the grep sees them; caught by the fixpoint's consumer question:

- `runLegacy` in `src/main/appBootstrapCommand.ts` — only `legacyPickupPorts.ts` called it.
- `userConfigSkillsDir` in `src/main/userConfig.ts` — only the `skills` destination used it.

---

# J. Fixpoint result

Seeding the walk with §A's 21 delete-whole modules and re-asking the consumer question yields **two**
further orphan modules (§I), and then **zero** on the next round. The walk terminates at round 3.

Survivors that still import a deleted module — i.e. the exact set that **must** be Split — are:
`src/main/index.ts`, `src/main/flow.ts`, `src/main/auditRecorder.ts`, plus the renderer and shared modules
listed in §B. That set is derived, not guessed: it is what the graph reports.

---

# K. Review status — one mandated step did not complete

**The ticket's devil's-advocate subagent pass did not return.** #98 requires: *"Before presenting it, the
impl agent spawns a devil's-advocate subagent to review the list against this ticket and the plan,
evaluates its findings, and addresses the valid ones."* The subagent was spawned against this list, the
ticket and the plan, and was asked twice for partial findings; it had produced nothing by the end of the
iteration. **No finding from it has been incorporated, because none was received.** This is recorded here
rather than left for the operator to discover.

What stands in its place is an adversarial pass run directly against the tree while the subagent worked. It
is **not** a substitute — one reviewer, not two — but it was not nothing: it found five defects in the
list's first draft, three of them the exact class the ticket calls load-bearing.

| found by the self-pass | class |
|---|---|
| `src/shared/loopTurn.ts` filed Scrub when `AGENT_LOOP_DONE_REL_PATH` is a live default parameter | AC 3 — a scrub that would have changed behavior |
| `tests/integration/appBootstrapCommand.test.ts` and `tests/helpers/loopGate.ts` filed Scrub while importing deleted symbols | AC 3, same class |
| `tests/integration/loopNotifier.test.ts` — surviving subject, deleted fixtures, zero §26 citations | AC 2 — the trap the grep cannot see |
| `flow:markTurnComplete` / `flow:retryTurn` left as "verify at implementation time" | an unclosed hole in an agreed list |
| seven surviving zero-citation files carrying retiring surface (§I.2) | AC 1's reach |

**Recommended:** re-run the devil's-advocate pass against this list before agreeing to it. The list is
complete enough to review, and the operator's own review is the gate that matters — but the ticket asked
for two adversarial passes and got one.

---

# L. Checked and cleared

Recorded so the operator knows what was verified, not only what failed. Each was a plausible
mis-classification that a reader would reasonably challenge; each was checked against the tree.

| challenge | verdict |
|---|---|
| Does a §27 module import `LoopDef` from the deleted `loopDef.ts`? | **No.** The only occurrences outside deleted modules are prose: `loopDefV2.ts:1` ("independent of the §26 parser") and `artifactTree.ts:2` (a TODO — removed, §I.2). No type import survives. |
| Does §27 depend on `loopRecipe.composeConsolidatePrompt`? | **No — name collision.** `consolidateTurn.ts:53` exports its own; `appLoopEngine.ts:25` imports from `./consolidateTurn`. The §26 one (`loopRecipe.ts:92`) has no surviving consumer. |
| Is `src/main/loopNotifier.ts` §26-owned? | **No.** It observes a `FlowStateView` and names no engine (`:1`–`:6`). It survives; only its **test's fixtures** are §26-built (§I.2). |
| Is `src/shared/loopGate.ts` §26-only? | **No.** `loopGateActionable` reads `actionable !== false`; the §27 run-less view is its live producer. Scrub. |
| Does the §27 route-out share `flow:markTurnComplete` / `flow:retryTurn`? | **No.** §27 dispatches `appRouteOut` (`loopPanel.ts:178`–`:205`). Both channels go (§B.7). |
| Is `.agent-loop` still needed in `APP_STATE_DIRS`? | **Yes** — the surviving bootstrap's clean-tree gate reads it immediately before a branch deletion (§H.3). |
| Is `started_at` droppable from the flow-state document? | **No.** `PERSISTED_KEYS` is closed and the decoder rejects unknown keys (`flowState.ts:38`), so dropping it fails every existing document (§H.2). |
| Do the §25 `loop.cost` / `loop.ci` union members import `pricing.ts`? | **No.** `audit.ts:41`/`:44` carry plain numbers. The reader's fold stays; only the writer goes (§H.1, §B.14). |
| Is `tests/integration/confinedPath.test.ts`'s `loops` path an install destination? | **No.** A jail fixture directory name (`:47`, `:62`). Not touched. |
| Does any surviving module still call `runLegacy` / `userConfigSkillsDir`? | **No.** Sole callers were `legacyPickupPorts.ts` and the `skills` destination (§I.3). |
