import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createFlowManager, loadFlowDefinition, type FlowManager } from '../../src/main/flow';
import { MAX_LOOP_ARTIFACT_BYTES, readLoopArtifact } from '../../src/main/appLoopPaths';
import { createRepeatSourcer } from '../../src/main/repeatSourcing';
import { createFlowStateStore } from '../../src/main/flowState';
import { exampleSlicePlan } from '../../src/shared/slicePlan';
import { createApproveDriver, type ApproveDriver } from '../helpers/repeatApprove';
import { flowLocations, writeFlow, writeLoopDef, type FlowSpec, type FlowStepSpec, type RepeatSpec } from '../helpers/flowFixtures';
import { JSON_LIST_CASES, distinctTitles, jsonListText } from '../helpers/jsonListCases';

// #278 / §28.4.1 — a repeat's count re-sourced at each source approve, through the real approve path, the real
// sourcer and a real flow manager over a temp repository. Each test observes the steps the flow goes through.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (prefix: string): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};

/** What a step's work turn leaves at one of its outputs on its `n`-th run (from 1): text, bytes, a directory, or
 *  nothing. */
type Leave = string | Buffer | { directory: true } | null;
type Writes = Readonly<Record<string, (n: number) => Leave>>;

interface Rig {
  repo: string;
  flow: FlowManager;
  driver: ApproveDriver;
}

const SOURCE_LOOP = 'source-loop';
const WORK_LOOP = 'work-loop';
const GROUP_SOURCE_LOOP = 'group-source-loop';

/** A list-form repeat over the `steps` output: `check` loops back to `build`. */
const STEPS_LIST: RepeatSpec = { backTo: 'build', countFrom: { artifact: 'steps', format: 'json-list', list: 'steps' } };

/** `sources` loop steps that output `id`, then `build` and `check` (the group, `check` carrying `repeat`), then
 *  `finish` and a manual `done`. `buildSources` makes `build` output `id` too, so a source sits inside the group. */
function flowSpec(repeat: RepeatSpec, sources: readonly string[], buildSources = false): FlowSpec {
  const steps: FlowStepSpec[] = [
    ...sources.map((id): FlowStepSpec => ({ id, kind: 'loop', loop: SOURCE_LOOP })),
    { id: 'build', kind: 'loop', loop: buildSources ? GROUP_SOURCE_LOOP : WORK_LOOP },
    { id: 'check', kind: 'loop', loop: WORK_LOOP, repeat },
    { id: 'finish', kind: 'loop', loop: WORK_LOOP },
    { id: 'done', kind: 'manual' },
  ];
  return { name: 'repeat-sourcing', steps };
}

/** The repository, its flow and loops, and an approve driver whose re-source is the real sourcer reading through
 *  `readArtifact` (production's `readLoopArtifact` unless a test injects another), or none when `resources` is false. */
function rig(
  spec: FlowSpec,
  outputId: string,
  readArtifact: (path: string) => string | null = readLoopArtifact,
  alsoOutputs: readonly string[] = [],
  sourcerFlow: (flow: FlowManager) => FlowManager = (flow) => flow,
  resources = true,
): Rig {
  const repo = tmp('repeat-sourcing-repo-');
  const loopsRoot = tmp('repeat-sourcing-loops-');
  const gate = [{ option: 'approve' }];
  const also = Object.fromEntries(alsoOutputs.map((id) => [id, `${id}-out`]));
  writeLoopDef(loopsRoot, SOURCE_LOOP, { artifact: outputId, outputs: { [outputId]: 'source-out', ...also }, gate });
  writeLoopDef(loopsRoot, GROUP_SOURCE_LOOP, { artifact: outputId, outputs: { [outputId]: 'group-source-out' }, gate });
  writeLoopDef(loopsRoot, WORK_LOOP, { outputs: { result: 'work-result.md' }, gate });
  writeFlow(flowLocations.repoLocal(repo), spec);
  const flow = createFlowManager({ globalDir: tmp('repeat-sourcing-global-') });
  const sourcer = createRepeatSourcer({
    flow: sourcerFlow(flow),
    readArtifact,
    repeatOf: (repoDir) => {
      const load = loadFlowDefinition(repoDir);
      return load.ok ? load.definition.steps.find((s) => s.repeat !== undefined)?.repeat : undefined;
    },
  });
  const sourceSliceCount: typeof sourcer = resources ? sourcer : () => {};
  const driver = createApproveDriver({
    repoDir: repo,
    flow,
    spec,
    loops: { tiers: { operator: loopsRoot, appBundled: loopsRoot, retired: null }, repoDir: repo },
    sourceSliceCount,
  });
  return { repo, flow, driver };
}

function leave(file: string, what: Leave): void {
  rmSync(file, { recursive: true, force: true });
  if (what === null) return;
  mkdirSync(dirname(file), { recursive: true });
  if (typeof what === 'string' || Buffer.isBuffer(what)) return writeFileSync(file, what);
  mkdirSync(file);
}

const MAX_STEPS = 400;

/** Approves every loop step the flow reaches, each after its work turn leaves `writes[step]` at the output
 *  `outputId`, until the flow reaches a manual step. Returns the steps entered, in order. */
async function play(r: Rig, outputId: string, writes: Writes): Promise<string[]> {
  const seen: string[] = [];
  const runs: Record<string, number> = {};
  for (let i = 0; i < MAX_STEPS; i++) {
    const view = r.flow.state(r.repo);
    seen.push(view.stepName);
    if (view.stepName === 'done') return seen;
    runs[view.stepName] = (runs[view.stepName] ?? 0) + 1;
    const write = writes[view.stepName];
    if (write !== undefined) leave(r.driver.outputPath(view.stepName, outputId), write(runs[view.stepName]));
    await r.driver.approve(view.stepName);
  }
  return seen;
}

/** The step sequence of a run whose sources come before the group and whose group runs `times` times. */
const sequence = (sources: readonly string[], times: number): string[] => [...sources, ...Array.from({ length: times }, () => ['build', 'check']).flat(), 'finish', 'done'];

const always = (what: Leave) => (): Leave => what;
const NO_LIST = JSON.stringify({ marker: 'no list here' });
const list = (n: number): string => jsonListText(distinctTitles(n));

async function runFromStart(r: Rig, outputId: string, writes: Writes): Promise<string[]> {
  r.flow.start(r.repo);
  return play(r, outputId, writes);
}

describe('A JSON list sets the count', () => {
  it.each([1, 3, 50])('a source approve of a %i-entry list runs the group that many times, then the step after the repeat', async (n) => {
    const r = rig(flowSpec(STEPS_LIST, ['design']), 'steps');
    expect(await runFromStart(r, 'steps', { design: always(list(n)) })).toEqual(sequence(['design'], n));
  });

  it('the count comes from the named list of the named artifact, whatever their names', async () => {
    const items: RepeatSpec = { backTo: 'build', countFrom: { artifact: 'design-out', format: 'json-list', list: 'items' } };
    const r = rig(flowSpec(items, ['design']), 'design-out');
    const text = JSON.stringify({ steps: distinctTitles(2).map((title) => ({ title })), items: distinctTitles(3).map((title) => ({ title })) });
    expect(await runFromStart(r, 'design-out', { design: always(text) })).toEqual(sequence(['design'], 3));
  });

  it('a file that starts with a UTF-8 byte-order mark is judged on the rest', async () => {
    const r = rig(flowSpec(STEPS_LIST, ['design']), 'steps');
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(list(3))]);
    expect(await runFromStart(r, 'steps', { design: always(withBom) })).toEqual(sequence(['design'], 3));
  });
});

describe('The §28.4.1 bounds hold for a JSON list', () => {
  it.each([51, 60])('a %i-entry list runs the group MAX_SLICES (50) times', async (n) => {
    const r = rig(flowSpec(STEPS_LIST, ['design']), 'steps');
    expect(await runFromStart(r, 'steps', { design: always(list(n)) })).toEqual(sequence(['design'], 50));
  });

  const overBound = (): string => {
    const head = list(3);
    return `${head.slice(0, -1)}, "pad": "${'x'.repeat(MAX_LOOP_ARTIFACT_BYTES)}"}`;
  };
  const sourcesNothing: readonly (readonly [string, () => Leave])[] = [
    ['an absent file', () => null],
    ['a directory at the path', () => ({ directory: true })],
    ['a file over the 16 MiB read bound', overBound],
    ['a file that is not valid UTF-8', () => Buffer.concat([Buffer.from('{"steps": [{"title": "'), Buffer.from([0xc3, 0x28]), Buffer.from('"}]}')])],
    ...JSON_LIST_CASES.filter((c) => !c.expected.wellFormed && c.list === 'steps').map((c) => [`a file with ${c.name}`, () => c.text] as const),
  ];

  it.each(sourcesNothing)('%s sources nothing: the group runs once, and after a sourced 3-entry list the 3 stands', async (_name, bad) => {
    const alone = rig(flowSpec(STEPS_LIST, ['design']), 'steps');
    expect.soft(await runFromStart(alone, 'steps', { design: bad })).toEqual(sequence(['design'], 1));
    const afterGood = rig(flowSpec(STEPS_LIST, ['design', 'redesign']), 'steps');
    expect.soft(await runFromStart(afterGood, 'steps', { design: always(list(3)), redesign: bad })).toEqual(sequence(['design', 'redesign'], 3));
  });

  it('a re-source with fewer entries than the iteration the run is on keeps the current count', async () => {
    const r = rig(flowSpec(STEPS_LIST, ['design'], true), 'steps');
    const shrinking = (n: number): Leave => (n === 1 ? list(3) : list(1));
    expect(await runFromStart(r, 'steps', { design: always(NO_LIST), build: shrinking })).toEqual(sequence(['design'], 3));
  });
});

describe('Every source approve re-sources', () => {
  it("in a list-form flow, only the count_from artifact sources the count: a plan output beside it never does, and still writes the slices input", async () => {
    const approveDesign = async (steps: Leave): Promise<{ slices: string | undefined; seen: string[] }> => {
      const r = rig(flowSpec(STEPS_LIST, ['design']), 'steps', readLoopArtifact, ['plan']);
      r.flow.start(r.repo);
      leave(r.driver.outputPath('design', 'plan'), exampleSlicePlan(3));
      leave(r.driver.outputPath('design', 'steps'), steps);
      await r.driver.approve('design');
      const slices = createFlowStateStore(r.repo).read()?.inputs?.slices;
      return { slices, seen: ['design', ...(await play(r, 'steps', {}))] };
    };
    expect.soft(await approveDesign(null)).toEqual({ slices: '3', seen: sequence(['design'], 1) });
    expect.soft(await approveDesign(list(2))).toEqual({ slices: '3', seen: sequence(['design'], 2) });
  });

  it.each([
    ['a 3-slice plan sets both the list count and the slices input', exampleSlicePlan(3), '3', 3],
    ['a malformed plan sources neither', '## Impl-slices\n', undefined, 1],
  ] as const)('a list-form repeat whose count_from artifact is plan: %s', async (_name, text, slices, times) => {
    const fromPlan: RepeatSpec = { backTo: 'build', countFrom: { artifact: 'plan', format: 'impl-slices' } };
    const r = rig(flowSpec(fromPlan, ['plan']), 'plan');
    r.flow.start(r.repo);
    leave(r.driver.outputPath('plan', 'plan'), text);
    await r.driver.approve('plan');
    const sourced = createFlowStateStore(r.repo).read()?.inputs?.slices;
    expect({ slices: sourced, seen: ['plan', ...(await play(r, 'plan', {}))] }).toEqual({ slices, seen: sequence(['plan'], times) });
  });

  it("the count_from artifact sources the count when the source loop's work artifact is another output", async () => {
    const approveDesign = async (steps: Leave): Promise<string[]> => {
      const r = rig(flowSpec(STEPS_LIST, ['design']), 'notes', readLoopArtifact, ['steps']);
      r.flow.start(r.repo);
      leave(r.driver.outputPath('design', 'notes'), list(4));
      leave(r.driver.outputPath('design', 'steps'), steps);
      await r.driver.approve('design');
      return ['design', ...(await play(r, 'result', {}))];
    };
    expect.soft(await approveDesign(NO_LIST)).toEqual(sequence(['design'], 1));
    expect.soft(await approveDesign(list(2))).toEqual(sequence(['design'], 2));
  });

  it('an approve of a step that is not a source never sets the count, even when its own output holds a list', async () => {
    const withBuildList = async (design: Leave): Promise<string[]> => {
      const r = rig(flowSpec(STEPS_LIST, ['design']), 'steps');
      r.flow.start(r.repo);
      leave(r.driver.outputPath('design', 'steps'), design);
      await r.driver.approve('design');
      return ['design', ...(await play(r, 'result', { build: always(list(5)) }))];
    };
    expect.soft(await withBuildList(NO_LIST)).toEqual(sequence(['design'], 1));
    expect.soft(await withBuildList(list(3))).toEqual(sequence(['design'], 3));
  });

  it.each([
    [2, 4],
    [4, 2],
  ])('two source steps sourcing %i then %i entries: the later one sets the count', async (first, second) => {
    const r = rig(flowSpec(STEPS_LIST, ['design', 'redesign']), 'steps');
    expect(await runFromStart(r, 'steps', { design: always(list(first)), redesign: always(list(second)) })).toEqual(sequence(['design', 'redesign'], second));
  });

  it("a source step inside the group re-sources on each of its approves: 3 entries, then 2 on the second iteration", async () => {
    const r = rig(flowSpec(STEPS_LIST, ['design'], true), 'steps');
    const thenTwo = (n: number): Leave => (n === 1 ? list(3) : list(2));
    expect(await runFromStart(r, 'steps', { design: always(NO_LIST), build: thenTwo })).toEqual(sequence(['design'], 2));
  });
});

describe('A failed re-source never blocks the advance', () => {
  const failed = (r: Rig) => r.driver.audits.filter((a) => /source-slices.failed/.test(a.cmd));

  it('an artifact read that throws still advances, and records a source-slices-failed entry', async () => {
    const r = rig(flowSpec(STEPS_LIST, ['design']), 'steps', () => {
      throw new Error('EACCES: the list cannot be read');
    });
    expect.soft(await runFromStart(r, 'steps', { design: always(list(3)) })).toEqual(sequence(['design'], 1));
    expect.soft(failed(r).map((a) => a.exit)).toEqual([1]);
  });

  it('a sourced list that cannot be recorded still advances, and records a source-slices-failed entry', async () => {
    const READS: ReadonlySet<PropertyKey> = new Set(['state', 'currentSlice', 'sliceStartStep']);
    const unwritable = (flow: FlowManager): FlowManager =>
      new Proxy(flow, {
        get: (target, key, receiver) =>
          READS.has(key)
            ? Reflect.get(target, key, receiver)
            : () => {
                throw new Error('cannot write .agent-terminal/flow-state.yaml');
              },
      });
    const r = rig(flowSpec(STEPS_LIST, ['design']), 'steps', readLoopArtifact, [], unwritable);
    expect.soft(await runFromStart(r, 'steps', { design: always(list(3)) })).toEqual(sequence(['design'], 1));
    expect.soft(failed(r).map((a) => a.exit)).toEqual([1]);
  });

  it('an approve that sources nothing adds no audit entry, beside one that does source a count', async () => {
    const nothing = rig(flowSpec(STEPS_LIST, ['design']), 'steps');
    expect.soft(await runFromStart(nothing, 'steps', { design: always(NO_LIST) })).toEqual(sequence(['design'], 1));
    const unsourced = rig(flowSpec(STEPS_LIST, ['design']), 'steps', readLoopArtifact, [], (flow) => flow, false);
    await runFromStart(unsourced, 'steps', { design: always(NO_LIST) });
    expect.soft(nothing.driver.audits).toEqual(unsourced.driver.audits);
    const sourced = rig(flowSpec(STEPS_LIST, ['design']), 'steps');
    expect.soft(await runFromStart(sourced, 'steps', { design: always(list(2)) })).toEqual(sequence(['design'], 2));
  });
});

describe('impl-slices works from any artifact', () => {
  const DESIGN_SLICES: RepeatSpec = { backTo: 'build', countFrom: { artifact: 'design', format: 'impl-slices' } };

  it.each([
    ['a well-formed 3-slice block', exampleSlicePlan(3), 3],
    ['a well-formed 60-slice block', exampleSlicePlan(60), 50],
    ['a malformed block', '## Impl-slices\n\n### Impl-slice 1 — no ac line\n', 1],
  ] as const)('a design artifact holding %s runs the group as the plan count would', async (_name, text, times) => {
    const r = rig(flowSpec(DESIGN_SLICES, ['design']), 'design');
    expect(await runFromStart(r, 'design', { design: always(text) })).toEqual(sequence(['design'], times));
  });

  it('a shrinking re-source from inside the group keeps the current count', async () => {
    const r = rig(flowSpec(DESIGN_SLICES, ['design'], true), 'design');
    const shrinking = (n: number): Leave => exampleSlicePlan(n === 1 ? 3 : 1);
    expect(await runFromStart(r, 'design', { design: always('no block'), build: shrinking })).toEqual(sequence(['design'], 3));
  });
});

describe("Today's form is unchanged: count_input sourced from the plan output", () => {
  const SLICES_INPUT: RepeatSpec = { backTo: 'build', countInput: 'slices' };

  it.each([
    ['1 slice', exampleSlicePlan(1), 1],
    ['3 slices', exampleSlicePlan(3), 3],
    ['60 slices', exampleSlicePlan(60), 50],
    ['a malformed block', '## Impl-slices\n', 1],
  ] as const)('a plan of %s runs the group as before', async (_name, text, times) => {
    const r = rig(flowSpec(SLICES_INPUT, ['plan']), 'plan');
    expect(await runFromStart(r, 'plan', { plan: always(text) })).toEqual(sequence(['plan'], times));
  });

  it.each([
    ['a shrinking re-source keeps the current count', 1, 3],
    ['a re-source covering the current iteration sets the count', 2, 2],
  ] as const)('a plan source inside the group: %s', async (_name, secondSlices, times) => {
    const r = rig(flowSpec(SLICES_INPUT, ['plan'], true), 'plan');
    const plans = (n: number): Leave => exampleSlicePlan(n === 1 ? 3 : secondSlices);
    expect(await runFromStart(r, 'plan', { plan: always('no block'), build: plans })).toEqual(sequence(['plan'], times));
  });
});

describe('The sourced list in flow-state.yaml: its read boundary and its clearing', () => {
  const stateFile = (repo: string): string => join(repo, '.agent-terminal', 'flow-state.yaml');
  /** A run planted at `build` whose persisted record is `record`, advanced to `done` with no source approve. */
  const plantedRun = (record: string): Rig => {
    const r = rig(flowSpec(STEPS_LIST, ['design']), 'steps');
    writeFileSync(stateFile(r.repo), `step: build\nstatus: in_progress\n${record}`);
    return r;
  };
  const advanceToDone = (r: Rig): string[] => {
    const seen: string[] = [];
    for (let i = 0; i < MAX_STEPS && r.flow.state(r.repo).stepName !== 'done'; i++) {
      seen.push(r.flow.state(r.repo).stepName);
      r.flow.advance(r.repo);
    }
    return seen;
  };
  const groupOf = (times: number): string[] => sequence([], times).slice(0, -1);

  it('a persisted { count: 3 } record runs the group 3 times; a count of 0, -1, 2.5 or a word reads as no record', () => {
    expect.soft(advanceToDone(plantedRun('repeat_list:\n  count: 3\n'))).toEqual(groupOf(3));
    expect.soft(advanceToDone(plantedRun('repeat_list:\n  count: 60\n')), 'clamped where it is used').toEqual(groupOf(50));
    for (const bad of ['0', '-1', '2.5', 'three']) {
      expect.soft(advanceToDone(plantedRun(`repeat_list:\n  count: ${bad}\n`)), bad).toEqual(groupOf(1));
    }
  });

  it('the strict write keeps a valid record and refuses an ill-typed one, leaving its file byte-for-byte', () => {
    const valid = plantedRun('repeat_list:\n  count: 3\n');
    expect.soft(() => valid.flow.setTitle(valid.repo, 'Named')).not.toThrow();
    expect.soft(advanceToDone(valid)).toEqual(groupOf(3));
    for (const count of ['0', '-1', '2.5', 'three']) {
      const bad = plantedRun(`repeat_list:\n  count: ${count}\n`);
      const before = readFileSync(stateFile(bad.repo), 'utf8');
      expect.soft(() => bad.flow.setTitle(bad.repo, 'Named'), count).toThrow(/unrecognized/i);
      expect.soft(readFileSync(stateFile(bad.repo), 'utf8'), count).toBe(before);
    }
  });

  const listThenNone = { design: always(list(3)) };

  it('a restart clears the sourced list: the next run sources nothing and runs the group once', async () => {
    const r = rig(flowSpec(STEPS_LIST, ['design']), 'steps');
    const sourced = await runFromStart(r, 'steps', listThenNone);
    r.flow.advance(r.repo);
    r.flow.restart(r.repo);
    const afterRestart = await play(r, 'steps', { design: always(NO_LIST) });
    expect([sourced, afterRestart]).toEqual([sequence(['design'], 3), sequence(['design'], 1)]);
  });

  it('a terminate clears the sourced list: a new Start that sources nothing runs the group once', async () => {
    const r = rig(flowSpec(STEPS_LIST, ['design']), 'steps');
    const sourced = await runFromStart(r, 'steps', listThenNone);
    r.flow.terminate(r.repo);
    const afterTerminate = await runFromStart(r, 'steps', { design: always(NO_LIST) });
    expect([sourced, afterTerminate]).toEqual([sequence(['design'], 3), sequence(['design'], 1)]);
  });

  it('a reopen of the slice keeps the sourced list: the reopened iteration re-runs, and the group still runs 3 times', async () => {
    const r = rig(flowSpec(STEPS_LIST, ['design']), 'steps');
    r.flow.start(r.repo);
    const seen: string[] = [];
    for (let i = 0; i < MAX_STEPS; i++) {
      const at = r.flow.state(r.repo).stepName;
      seen.push(at);
      if (at === 'done' || (at === 'check' && seen.filter((s) => s === 'check').length === 2)) break;
      if (at === 'design') leave(r.driver.outputPath('design', 'steps'), list(3));
      await r.driver.approve(at);
    }
    if (seen.at(-1) === 'check') {
      r.flow.reopenSlice(r.repo);
      seen.push(...(await play(r, 'steps', { design: always(NO_LIST) })));
    }
    expect(seen).toEqual(sequence(['design'], 4));
  });

  it('a revert to not-started clears the sourced list, and a revert to an earlier step keeps it', async () => {
    const reverted = (toNotStarted: boolean) => async (): Promise<string[]> => {
      const r = rig(flowSpec(STEPS_LIST, ['design']), 'steps');
      r.flow.start(r.repo);
      leave(r.driver.outputPath('design', 'steps'), list(3));
      await r.driver.approve('design');
      r.flow.revertStep(r.repo, 'build');
      if (toNotStarted) {
        r.flow.revertStep(r.repo, 'design');
        r.flow.start(r.repo);
      }
      return play(r, 'steps', { design: always(NO_LIST) });
    };
    const runs = { toEarlierStep: await reverted(false)(), toNotStarted: await reverted(true)() };
    expect(runs).toEqual({ toEarlierStep: sequence(['design'], 3), toNotStarted: sequence(['design'], 1) });
  });
});
