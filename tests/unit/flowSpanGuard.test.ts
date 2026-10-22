import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFlowManager, type FlowManager, type FlowSpanPort } from '../../src/main/flow';
import { createFlowStateStore, type PersistedFlowState } from '../../src/main/flowState';
import type { StepSpan } from '../../src/shared/flowStepSpan';

// #180 — the span guard: under a span port, a move whose target is outside the span is not taken and ends the
// span, a failed bootstrap's rollback out of it is not taken and ends nothing, a move inside it is taken, and a
// span the held definition cannot resolve takes no step-changing move. Without a span every move is as today.

const FLOW =
  'name: span-guard\nsteps:\n' +
  '  - id: a\n    kind: manual\n' +
  '  - id: b\n    kind: manual\n' +
  '  - id: c\n    kind: manual\n    repeat:\n      back_to: a\n      count_input: slices\n' +
  '  - id: d\n    kind: manual\n';

type Move = 'advance' | 'reopenSlice' | 'restart' | 'revertStep';

interface Rig {
  flow: FlowManager;
  entered: string[];
  ended: [string, string][];
}

let repo: string;
let home: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'flow-span-guard-'));
  home = mkdtempSync(join(tmpdir(), 'flow-span-guard-home-'));
  mkdirSync(join(repo, '.agent-terminal'), { recursive: true });
  writeFileSync(join(repo, '.agent-terminal', 'flow.yaml'), FLOW);
});
afterEach(() => {
  for (const d of [repo, home]) rmSync(d, { recursive: true, force: true });
});

const seed = (state: PersistedFlowState): void => createFlowStateStore(repo).write(state);
const stateFile = (): string => readFileSync(join(repo, '.agent-terminal', 'flow-state.yaml'), 'utf8');

/** A manager over `repo`, under `span` for `repo` alone when one is given, recording entries and endings. */
function rig(span?: StepSpan | 'null-for-repo'): Rig {
  const entered: string[] = [];
  const ended: [string, string][] = [];
  const port: FlowSpanPort | undefined =
    span === undefined
      ? undefined
      : { spanFor: (k) => (span !== 'null-for-repo' && k === repo ? span : null), ended: (k, ending) => ended.push([k, ending]) };
  const flow = createFlowManager({ globalDir: home, onEnterStep: (step) => void entered.push(step.id), ...(port ? { span: port } : {}) });
  return { flow, entered, ended };
}

const act = (r: Rig, move: Move, from: string): void => {
  if (move === 'revertStep') r.flow.revertStep(repo, from);
  else r.flow[move](repo);
};

interface Case {
  name: string;
  span: StepSpan;
  seed: PersistedFlowState;
  move: Move;
  /** Where the move lands with no span, as today. */
  today: { step: string; status: string };
}

const OUT_OF_SPAN: Case[] = [
  { name: 'an advance to the next step', span: { first: 'b', last: 'c' }, seed: { step: 'c', status: 'in_progress' }, move: 'advance', today: { step: 'd', status: 'in_progress' } },
  { name: 'a loop-back', span: { first: 'b', last: 'c' }, seed: { step: 'c', status: 'in_progress', inputs: { slices: '2' } }, move: 'advance', today: { step: 'a', status: 'in_progress' } },
  { name: 'a back-to-RED reopen', span: { first: 'b', last: 'c' }, seed: { step: 'c', status: 'in_progress' }, move: 'reopenSlice', today: { step: 'a', status: 'in_progress' } },
  { name: 'a restart', span: { first: 'c', last: 'd' }, seed: { step: 'd', status: 'done' }, move: 'restart', today: { step: 'a', status: 'in_progress' } },
];

const ROLLBACKS: Case[] = [
  { name: 'to the previous step', span: { first: 'b', last: 'c' }, seed: { step: 'b', status: 'in_progress' }, move: 'revertStep', today: { step: 'a', status: 'in_progress' } },
  { name: 'from the first step, to before the flow', span: { first: 'a', last: 'b' }, seed: { step: 'a', status: 'in_progress' }, move: 'revertStep', today: { step: 'a', status: 'not_started' } },
];

describe('the span guard (#180)', () => {
  it.each(OUT_OF_SPAN)('does not take $name out of the span, and reports left span once', (c) => {
    seed(c.seed);
    const before = stateFile();
    const r = rig(c.span);

    act(r, c.move, c.seed.step);

    const view = r.flow.state(repo);
    expect({ step: view.stepName, status: view.status, persisted: stateFile(), entered: r.entered, ended: r.ended }).toEqual({
      step: c.seed.step,
      status: c.seed.status,
      persisted: before,
      entered: [],
      ended: [[repo, 'left span']],
    });
  });

  it.each(ROLLBACKS)('does not take a failed bootstrap\'s rollback $name out of the span, and reports nothing', (c) => {
    seed(c.seed);
    const before = stateFile();
    const r = rig(c.span);

    act(r, c.move, c.seed.step);

    const view = r.flow.state(repo);
    expect({ step: view.stepName, status: view.status, persisted: stateFile(), ended: r.ended }).toEqual({
      step: c.seed.step,
      status: c.seed.status,
      persisted: before,
      ended: [],
    });
  });

  // A first-step rollback resets a begun run, so the manager removes its run record before the flow moves: the guard
  // must leave that record in place too.
  it.each([
    ['keeps a begun run and its record when its first-step rollback leaves the span', { first: 'a', last: 'b' }, { step: 'a', status: 'in_progress', kept: true }],
    ['resets a begun run and removes its record on a first-step rollback with no span port, as today', undefined, { step: 'a', status: 'not_started', kept: false }],
  ] as const)('%s', (_name, span, expected) => {
    seed({ step: 'a', status: 'not_started' });
    const r = rig(span);
    r.flow.start(repo);
    const begun = r.flow.state(repo).runStarted;

    r.flow.revertStep(repo, 'a');

    const view = r.flow.state(repo);
    expect({ step: view.stepName, status: view.status, kept: view.runStarted === begun, ended: r.ended }).toEqual({ ...expected, ended: [] });
  });

  it.each([...OUT_OF_SPAN, ...ROLLBACKS])('takes $name as today with no span port', (c) => {
    seed(c.seed);
    const r = rig();

    act(r, c.move, c.seed.step);

    const view = r.flow.state(repo);
    expect({ step: view.stepName, status: view.status }).toEqual(c.today);
  });

  it.each([...OUT_OF_SPAN, ...ROLLBACKS])('takes $name as today when the port names no span for the repo', (c) => {
    seed(c.seed);
    const r = rig('null-for-repo');

    act(r, c.move, c.seed.step);

    const view = r.flow.state(repo);
    expect({ step: view.stepName, status: view.status, ended: r.ended }).toEqual({ ...c.today, ended: [] });
  });

  it.each([
    { name: 'an advance', seed: { step: 'a', status: 'in_progress' } as PersistedFlowState, move: 'advance' as Move, to: 'b' },
    { name: 'a loop-back', seed: { step: 'c', status: 'in_progress', inputs: { slices: '2' } } as PersistedFlowState, move: 'advance' as Move, to: 'a' },
    { name: 'a back-to-RED reopen', seed: { step: 'c', status: 'in_progress' } as PersistedFlowState, move: 'reopenSlice' as Move, to: 'a' },
  ])('takes $name inside the span and reports nothing', (c) => {
    seed(c.seed);
    const r = rig({ first: 'a', last: 'c' });

    act(r, c.move, c.seed.step);

    expect({ step: r.flow.state(repo).stepName, entered: r.entered, ended: r.ended }).toEqual({ step: c.to, entered: [c.to], ended: [] });
  });

  it('completes the flow and reports completed when the span ends at the flow\'s last step', () => {
    seed({ step: 'd', status: 'in_progress' });
    const r = rig({ first: 'c', last: 'd' });

    r.flow.advance(repo);

    expect({ status: r.flow.state(repo).status, ended: r.ended }).toEqual({ status: 'done', ended: [[repo, 'completed']] });
  });

  it('completes the flow and reports nothing when the port names no span for the repo', () => {
    seed({ step: 'd', status: 'in_progress' });
    const r = rig('null-for-repo');

    r.flow.advance(repo);

    expect({ status: r.flow.state(repo).status, ended: r.ended }).toEqual({ status: 'done', ended: [] });
  });

  const STEP_CHANGING: { name: string; seed: PersistedFlowState; move: Move; to: { step: string; status: string } }[] = [
    { name: 'an advance', seed: { step: 'b', status: 'in_progress' }, move: 'advance', to: { step: 'c', status: 'in_progress' } },
    { name: 'a back-to-RED reopen', seed: { step: 'c', status: 'in_progress' }, move: 'reopenSlice', to: { step: 'a', status: 'in_progress' } },
    { name: 'a restart', seed: { step: 'd', status: 'done' }, move: 'restart', to: { step: 'a', status: 'in_progress' } },
    { name: 'a rollback', seed: { step: 'b', status: 'in_progress' }, move: 'revertStep', to: { step: 'a', status: 'in_progress' } },
  ];

  for (const [why, span] of [
    ['names a step the definition lacks', { first: 'zz', last: 'c' }],
    ['is in the wrong order', { first: 'c', last: 'b' }],
  ] as const) {
    it.each(STEP_CHANGING)(`takes no $name under a span that ${why}, and reports nothing`, (c) => {
      seed(c.seed);
      const before = stateFile();
      const r = rig(span);

      act(r, c.move, c.seed.step);

      const view = r.flow.state(repo);
      expect({ step: view.stepName, status: view.status, persisted: stateFile(), ended: r.ended }).toEqual({
        step: c.seed.step,
        status: c.seed.status,
        persisted: before,
        ended: [],
      });
    });
  }

  it.each(STEP_CHANGING)('takes $name under a valid span that holds its target', (c) => {
    seed(c.seed);
    const r = rig({ first: 'a', last: 'd' });

    act(r, c.move, c.seed.step);

    const view = r.flow.state(repo);
    expect({ step: view.stepName, status: view.status, ended: r.ended }).toEqual({ ...c.to, ended: [] });
  });
});
