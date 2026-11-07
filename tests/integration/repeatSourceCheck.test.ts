import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFlowManager, loadUntrustedFlowDefinition, type FlowDefinition, type FlowStepDef } from '../../src/main/flow';
import { createRunResolver } from '../../src/main/runResolver';
import { writeActiveFlow } from '../../src/main/activeFlowPointer';
import { createFlowStateStore } from '../../src/main/flowState';
import { createAutoGate } from '../../src/main/autoGate';
import { resolveRuntimeConfig } from '../../src/main/runtimeConfig';
import { composeCountSourceRefusal, composeStartTransition } from '../../src/main/autoGateComposition';
import { countSourceRefusal } from '../../src/main/repeatSourceCheck';
import type { LoopDefV2Tiers } from '../../src/main/loopDefV2';
import { flowLocations, writeFlow, writeLoopDef, type FlowSpec, type FlowStepSpec, type RepeatSpec } from '../helpers/flowFixtures';

// §28.4.1 — a list-form repeat whose `count_from.artifact` no resolved loop outputs: the shared check, and
// the Start it refuses through the production loop lookup.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (prefix: string): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};

const REPEAT_STEP = 'tally';
const listForm = (artifact: string): RepeatSpec => ({ backTo: 'build', countFrom: { artifact, format: 'json-list', list: 'steps' } });
const INPUT_FORM: RepeatSpec = { backTo: 'build', countInput: 'slices' };

/** `before` loop steps, then `build` and `tally` (the group, `tally` carrying `repeat`), then `after` loop steps and
 *  a manual `done`. Each extra step is `[id, loop]`. */
function flowSpec(name: string, repeat: RepeatSpec, before: readonly [string, string][], after: readonly [string, string][] = []): FlowSpec {
  const loopStep = ([id, loop]: readonly [string, string]): FlowStepSpec => ({ id, kind: 'loop', loop });
  return {
    name,
    steps: [
      ...before.map(loopStep),
      { id: 'build', kind: 'loop', loop: 'work-loop' },
      { id: REPEAT_STEP, kind: 'loop', loop: 'work-loop', repeat },
      ...after.map(loopStep),
      { id: 'done', kind: 'manual' },
    ],
  };
}

describe('the shared check of a list-form repeat count source', () => {
  /** The definition `spec` loads to, through the flow loader. */
  const definitionOf = (spec: FlowSpec): FlowDefinition => {
    const load = loadUntrustedFlowDefinition(writeFlow(tmp('repeat-source-check-flow-'), spec));
    if (!load.ok) throw new Error(`fixture: the flow does not load: ${load.error}`);
    return load.definition;
  };
  /** Each loop's declared output ids; a loop absent from `outputs` does not resolve. */
  const outputsBy =
    (outputs: Readonly<Record<string, readonly string[]>>) =>
    (step: FlowStepDef): readonly string[] | null =>
      step.loop === undefined ? null : (outputs[step.loop] ?? null);
  const LOOPS = { 'source-loop': ['steps'], 'work-loop': ['result'] };

  /** What the check says, as the facts a reader needs: refused or not, and whether it names the step and artifact. */
  const verdict = (reason: string | null, artifact: string) =>
    reason === null ? { refused: false } : { refused: true, namesStep: reason.includes(REPEAT_STEP), namesArtifact: reason.includes(artifact) };
  const REFUSED = { refused: true, namesStep: true, namesArtifact: true };

  it('passes a flow whose source step before the group outputs the artifact', () => {
    const def = definitionOf(flowSpec('f', listForm('steps'), [['design', 'source-loop']]));
    expect(countSourceRefusal(def, outputsBy(LOOPS))).toBeNull();
  });

  it('passes a flow whose only source step sits inside or after the group', () => {
    const inside = definitionOf({
      name: 'f',
      steps: [
        { id: 'build', kind: 'loop', loop: 'source-loop' },
        { id: REPEAT_STEP, kind: 'loop', loop: 'work-loop', repeat: listForm('steps') },
        { id: 'done', kind: 'manual' },
      ],
    });
    const after = definitionOf(flowSpec('f', listForm('steps'), [], [['redesign', 'source-loop']]));
    expect.soft(countSourceRefusal(inside, outputsBy(LOOPS))).toBeNull();
    expect.soft(countSourceRefusal(after, outputsBy(LOOPS))).toBeNull();
  });

  it('refuses an artifact no loop outputs, naming the repeat step and the artifact', () => {
    const def = definitionOf(flowSpec('f', listForm('nowhere'), [['design', 'source-loop']]));
    expect(verdict(countSourceRefusal(def, outputsBy(LOOPS)), 'nowhere')).toEqual(REFUSED);
  });

  it('refuses when the only loop that would output the artifact does not resolve', () => {
    const def = definitionOf(flowSpec('f', listForm('steps'), [['design', 'source-loop']]));
    expect(verdict(countSourceRefusal(def, outputsBy({ 'work-loop': ['result'] })), 'steps')).toEqual(REFUSED);
  });

  it('matches the artifact id exactly: a whitespace-only or padded id is refused unless a loop outputs that same id', () => {
    const blank = definitionOf(flowSpec('f', listForm(' '), [['design', 'source-loop']]));
    const padded = definitionOf(flowSpec('f', listForm(' steps'), [['design', 'source-loop']]));
    expect.soft(verdict(countSourceRefusal(blank, outputsBy(LOOPS)), ' ')).toEqual(REFUSED);
    expect.soft(verdict(countSourceRefusal(padded, outputsBy(LOOPS)), ' steps')).toEqual(REFUSED);
    expect.soft(countSourceRefusal(blank, outputsBy({ ...LOOPS, 'source-loop': [' '] }))).toBeNull();
    expect.soft(countSourceRefusal(padded, outputsBy({ ...LOOPS, 'source-loop': [' steps'] }))).toBeNull();
  });

  it('never checks the input form, nor a flow with no repeat, though no loop outputs anything', () => {
    const inputForm = definitionOf(flowSpec('f', INPUT_FORM, [['design', 'source-loop']]));
    const noRepeat = definitionOf({ name: 'f', steps: [{ id: 'build', kind: 'loop', loop: 'work-loop' }] });
    expect.soft(countSourceRefusal(inputForm, outputsBy({}))).toBeNull();
    expect.soft(countSourceRefusal(noRepeat, outputsBy({}))).toBeNull();
  });
});

describe('pressing Start on a list-form flow whose count source no resolved loop outputs', () => {
  const FLOW_ID = 'rl';
  /** Differs from the folder id, so a loop scoped to the flow is found only by the run's flow name. */
  const FLOW_NAME = 'repeat-run';

  interface Rig {
    repo: string;
    operator: string;
    start: () => ReturnType<ReturnType<typeof composeStartTransition>>;
    persistedStatus: () => string | null;
    status: () => string;
  }

  /** A repository whose active flow is `spec` (a catalog entry), with `work-loop` in the operator tier's shared
   *  folder, and the production Start composed over the app-shaped loop tiers. */
  function rig(spec: FlowSpec): Rig {
    const repo = tmp('repeat-source-start-repo-');
    const globalDir = tmp('repeat-source-start-global-');
    const operator = tmp('repeat-source-start-operator-');
    const appBundled = tmp('repeat-source-start-bundled-');
    const tiers: LoopDefV2Tiers = { operator, appBundled, retired: null };
    writeLoopDef(operator, 'work-loop', { outputs: { result: 'result.md' } });
    writeFlow(flowLocations.repoCatalogEntry(repo, FLOW_ID), spec);
    writeActiveFlow(repo, FLOW_ID);
    const resolve = createRunResolver(globalDir);
    const flow = createFlowManager({ globalDir, loadDefinition: (repoKey) => resolve(repoKey) });
    const gate = createAutoGate({
      audit: () => {},
      resolveDef: () => null,
      currentRun: () => null,
      runInProgressAt: () => true,
      onViewChanged: () => {},
      emitError: () => {},
      setTimer: () => ({ id: 0 }),
      clearTimer: () => {},
      decisionBoundMs: resolveRuntimeConfig({}).autoGateDecisionMs,
      askAgentWhy: () => {},
      withdrawAgentQuestion: () => {},
      currentSlice: () => 1,
    });
    const flowStart = composeStartTransition({
      autoGate: gate,
      resolveForStart: (repoKey) => {
        const load = resolve(repoKey).load;
        return load.ok ? { definition: load.definition } : null;
      },
      start: (repoKey, opts) => flow.start(repoKey, opts),
      countSourceRefusal: composeCountSourceRefusal(tiers),
      state: (repoKey) => flow.state(repoKey),
      now: () => 1_000,
      record: () => {},
    });
    return {
      repo,
      operator,
      start: () => flowStart(repo),
      persistedStatus: () => createFlowStateStore(repo).read()?.status ?? null,
      status: () => flow.state(repo).status,
    };
  }

  /** The Start's observable result: the view it returned, its notice's facts, and the run as persisted after. */
  const startOutcome = (r: Rig, artifact: string) => {
    const view = r.start();
    const notice = view.notice ?? '';
    return {
      status: view.status,
      noticeNamesStep: notice.includes(REPEAT_STEP),
      noticeNamesArtifact: notice.includes(artifact),
      statusAfter: r.status(),
      persisted: r.persistedStatus(),
    };
  };
  const REFUSED = { status: 'not_started', noticeNamesStep: true, noticeNamesArtifact: true, statusAfter: 'not_started', persisted: null };

  it('finds a source loop held only in the run\'s own flow folder, so Start goes ahead; with that loop gone, Start is refused and persists nothing', () => {
    const spec = flowSpec(FLOW_NAME, listForm('steps'), [['design', 'source-loop']]);
    const found = rig(spec);
    writeLoopDef(found.operator, 'source-loop', { artifact: 'steps', outputs: { steps: 'steps.json' } }, { flow: FLOW_NAME });
    expect.soft(found.start().status).toBe('in_progress');

    const missing = rig(spec);
    writeLoopDef(missing.operator, 'other-loop', { artifact: 'steps', outputs: { steps: 'steps.json' } }, { flow: FLOW_NAME });
    expect.soft(startOutcome(missing, 'steps')).toEqual(REFUSED);
  });

  it('refuses when the source step\'s loop does not resolve, and goes ahead when it resolves from the shared folder', () => {
    const spec = flowSpec(FLOW_NAME, listForm('steps'), [['design', 'source-loop']]);
    const unresolved = rig(spec);
    expect.soft(startOutcome(unresolved, 'steps')).toEqual(REFUSED);
    const resolved = rig(spec);
    writeLoopDef(resolved.operator, 'source-loop', { artifact: 'steps', outputs: { steps: 'steps.json' } });
    expect.soft(resolved.start().status).toBe('in_progress');
  });

  const RLO = String.fromCodePoint(0x202e);
  const BEL = String.fromCodePoint(0x07);
  const DISPLAY_UNSAFE = /[\p{Cc}\u202A-\u202E]/u;

  it('refuses an artifact id that no loop outputs with a display-safe notice that still names the repeat step', () => {
    const artifact = `${RLO}evil${BEL}${'x'.repeat(250)}`;
    const r = rig(flowSpec(FLOW_NAME, listForm(artifact), [['design', 'source-loop']]));
    writeLoopDef(r.operator, 'source-loop', { artifact: 'steps', outputs: { steps: 'steps.json' } });
    const view = r.start();
    const notice = view.notice ?? '';
    expect({
      status: view.status,
      namesStep: notice.includes(REPEAT_STEP),
      namesArtifact: notice.includes('evil'),
      bounded: notice.length > 0 && notice.length <= 200,
      unsafe: [...notice].filter((c) => DISPLAY_UNSAFE.test(c)),
    }).toEqual({ status: 'not_started', namesStep: true, namesArtifact: true, bounded: true, unsafe: [] });
  });

  it('starts an input-form flow and a flow with no repeat as before, though their loops do not resolve', () => {
    const inputForm = rig(flowSpec(FLOW_NAME, INPUT_FORM, [['design', 'unresolved-loop']]));
    const noRepeat = rig({ name: FLOW_NAME, steps: [{ id: 'build', kind: 'loop', loop: 'unresolved-loop' }, { id: 'done', kind: 'manual' }] });
    const started = (view: ReturnType<Rig['start']>) => ({ status: view.status, notice: view.notice });
    expect.soft(started(inputForm.start())).toEqual({ status: 'in_progress', notice: undefined });
    expect.soft(started(noRepeat.start())).toEqual({ status: 'in_progress', notice: undefined });
  });
});
