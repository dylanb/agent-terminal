import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createFlowManager, type FlowManager } from '../../src/main/flow';
import { MAX_LOOP_ARTIFACT_BYTES, readLoopArtifact } from '../../src/main/appLoopPaths';
import { createRepeatSourcer } from '../../src/main/repeatSourcing';
import { MAX_FLOW_STATE_BYTES, createFlowStateStore } from '../../src/main/flowState';
import type { RepeatEntry } from '../../src/shared/repeatList';
import { exampleSlicePlan } from '../../src/shared/slicePlan';
import { createApproveDriver, type ApproveDriver } from '../helpers/repeatApprove';
import { flowLocations, writeFlow, writeLoopDef, type FlowSpec, type FlowStepSpec, type RepeatSpec } from '../helpers/flowFixtures';
import { JSON_LIST_CASES, distinctTitles, jsonListText } from '../helpers/jsonListCases';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (prefix: string): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};

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

const STEPS_LIST: RepeatSpec = { backTo: 'build', countFrom: { artifact: 'steps', format: 'json-list', list: 'steps' } };

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

function rig(
  spec: FlowSpec,
  outputId: string,
  readArtifact: (path: string) => string | null = readLoopArtifact,
  alsoOutputs: readonly string[] = [],
  sourcerFlow: (flow: FlowManager) => FlowManager = (flow) => flow,
  resources = true,
  sourceOut = 'source-out',
): Rig {
  const repo = tmp('repeat-sourcing-repo-');
  const loopsRoot = tmp('repeat-sourcing-loops-');
  const gate = [{ option: 'approve' }];
  const also = Object.fromEntries(alsoOutputs.map((id) => [id, `${id}-out`]));
  writeLoopDef(loopsRoot, SOURCE_LOOP, { artifact: outputId, outputs: { [outputId]: sourceOut, ...also }, gate });
  writeLoopDef(loopsRoot, GROUP_SOURCE_LOOP, { artifact: outputId, outputs: { [outputId]: 'group-source-out' }, gate });
  writeLoopDef(loopsRoot, WORK_LOOP, { outputs: { result: 'work-result.md' }, gate });
  writeFlow(flowLocations.repoLocal(repo), spec);
  const flow = createFlowManager({ globalDir: tmp('repeat-sourcing-global-') });
  const sourcer = createRepeatSourcer({
    flow: sourcerFlow(flow),
    readArtifact,
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

async function play(r: Rig, outputId: string, writes: Writes, onStep: (step: string) => void = () => {}): Promise<string[]> {
  const seen: string[] = [];
  const runs: Record<string, number> = {};
  for (let i = 0; i < MAX_STEPS; i++) {
    const view = r.flow.state(r.repo);
    seen.push(view.stepName);
    onStep(view.stepName);
    if (view.stepName === 'done') return seen;
    runs[view.stepName] = (runs[view.stepName] ?? 0) + 1;
    const write = writes[view.stepName];
    if (write !== undefined) leave(r.driver.outputPath(view.stepName, outputId), write(runs[view.stepName]));
    await r.driver.approve(view.stepName);
  }
  return seen;
}

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
    const READS: ReadonlySet<PropertyKey> = new Set(['state', 'currentSlice', 'sliceStartStep', 'repeatSource']);
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

describe('A link at a count source is followed, as at every output', () => {
  it('a list-form repeat whose count_from artifact is plan, with plan a link to a 3-slice plan, sources both the count and the slices input', async () => {
    const fromPlan: RepeatSpec = { backTo: 'build', countFrom: { artifact: 'plan', format: 'impl-slices' } };
    const r = rig(flowSpec(fromPlan, ['plan']), 'plan');
    r.flow.start(r.repo);
    const file = r.driver.outputPath('plan', 'plan');
    mkdirSync(dirname(file), { recursive: true });
    const target = join(dirname(file), 'plan-target.md');
    writeFileSync(target, exampleSlicePlan(3));
    symlinkSync(target, file);
    await r.driver.approve('plan');
    const sourced = createFlowStateStore(r.repo).read()?.inputs?.slices;
    expect({ slices: sourced, seen: ['plan', ...(await play(r, 'plan', {}))] }).toEqual({ slices: '3', seen: sequence(['plan'], 3) });
  });
});

describe('A count_from artifact under a folder that links out of the artifacts folder is read at its confined real path', () => {
  it('when its file, a link back in, is swapped for a regular file outside the artifacts folder before the read, it still reads only the confined file', async () => {
    const outside = tmp('repeat-sourcing-outside-');
    const outsideFile = join(outside, 'list.json');
    const swapThenRead = (file: string): string | null => {
      rmSync(outsideFile, { force: true });
      writeFileSync(outsideFile, list(5));
      return readLoopArtifact(file);
    };
    const r = rig(flowSpec(STEPS_LIST, ['design']), 'steps', swapThenRead, [], (flow) => flow, true, 'out/list.json');
    const artifacts = dirname(dirname(r.driver.outputPath('design', 'steps')));
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, 'list.json'), list(3));
    symlinkSync(outside, join(artifacts, 'out'));
    symlinkSync(join(artifacts, 'list.json'), outsideFile);
    expect(await runFromStart(r, 'steps', {})).toEqual(sequence(['design'], 3));
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
  const plantedRun = (record: string, repeat: RepeatSpec = STEPS_LIST, extra = ''): Rig => {
    const r = rig(flowSpec(repeat, ['design']), 'steps');
    writeFileSync(stateFile(r.repo), `step: build\nstatus: in_progress\n${extra}${record}`);
    return r;
  };
  const TITLES_3 = '  titles:\n    - First\n    - Second\n    - Third\n';
  const BAD_COUNTS = ['0', '-1', '2.5', 'three', '.nan', '.inf', '-.inf'];
  const advanceToDone = (r: Rig): string[] => {
    const seen: string[] = [];
    for (let i = 0; i < MAX_STEPS && r.flow.state(r.repo).stepName !== 'done'; i++) {
      seen.push(r.flow.state(r.repo).stepName);
      r.flow.advance(r.repo);
    }
    return seen;
  };
  const groupOf = (times: number): string[] => sequence([], times).slice(0, -1);

  it('a valid persisted count sets the group count; a zero, negative, fractional, nonnumeric or non-finite count reads as no record', () => {
    expect.soft(advanceToDone(plantedRun(`repeat_list:\n  count: 3\n${TITLES_3}`))).toEqual(groupOf(3));
    expect.soft(advanceToDone(plantedRun(`repeat_list:\n  count: 60\n${TITLES_3}`)), 'clamped where it is used').toEqual(groupOf(50));
    for (const count of BAD_COUNTS) {
      const bad = plantedRun(`repeat_list:\n  count: ${count}\n${TITLES_3}`);
      expect.soft(bad.flow.entryFor(bad.repo, 'build'), count).toBeNull();
      expect.soft(advanceToDone(bad), count).toEqual(groupOf(1));
    }
  });

  const BAD_TITLES: readonly (readonly [string, string])[] = [
    ['no titles', ''],
    ['titles that are not a list', '  titles: First\n'],
    ['titles holding a non-string', '  titles:\n    - First\n    - 2\n    - Third\n'],
  ];

  it.each(BAD_TITLES)('a persisted record with %s reads as no record: no entry and the group runs once, beside a valid record that names its entry', (_name, titles) => {
    const valid = plantedRun(`repeat_list:\n  count: 3\n${TITLES_3}`);
    expect.soft(valid.flow.entryFor(valid.repo, 'build')).toEqual({ position: 1, count: 3, title: 'First' });
    expect.soft(advanceToDone(valid)).toEqual(groupOf(3));
    const bad = plantedRun(`repeat_list:\n  count: 3\n${titles}`);
    expect.soft(bad.flow.entryFor(bad.repo, 'build')).toBeNull();
    expect.soft(advanceToDone(bad)).toEqual(groupOf(1));
  });

  it('the strict write keeps a valid record and refuses an ill-typed one, leaving its file byte-for-byte', () => {
    const valid = plantedRun(`repeat_list:\n  count: 3\n${TITLES_3}`);
    expect.soft(() => valid.flow.setTitle(valid.repo, 'Named')).not.toThrow();
    expect.soft(advanceToDone(valid)).toEqual(groupOf(3));
    const records = [...BAD_COUNTS.map((count) => `repeat_list:\n  count: ${count}\n${TITLES_3}`), ...BAD_TITLES.map(([, titles]) => `repeat_list:\n  count: 3\n${titles}`)];
    for (const record of records) {
      const bad = plantedRun(record);
      const before = readFileSync(stateFile(bad.repo), 'utf8');
      expect.soft(() => bad.flow.setTitle(bad.repo, 'Named'), record).toThrow(/unrecognized/i);
      expect.soft(readFileSync(stateFile(bad.repo), 'utf8'), record).toBe(before);
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

type Named = readonly [step: string, entry: RepeatEntry | null];

async function playNamed(r: Rig, outputId: string, writes: Writes): Promise<Named[]> {
  const named: Named[] = [];
  await play(r, outputId, writes, (step) => named.push([step, r.flow.entryFor(r.repo, step)]));
  return named;
}

const entry = (position: number, count: number, title: string): RepeatEntry => ({ position, count, title });

function namedRun(sources: readonly string[], titles: readonly string[], count = titles.length): Named[] {
  const group = Array.from({ length: count }, (_, i): Named[] => [
    ['build', entry(i + 1, count, titles[i])],
    ['check', entry(i + 1, count, titles[i])],
  ]).flat();
  return [...sources.map((s): Named => [s, null]), ...group, ['finish', null], ['done', null]];
}

const unnamed = (steps: readonly string[]): Named[] => steps.map((s): Named => [s, null]);

const SLICES_INPUT_FORM: RepeatSpec = { backTo: 'build', countInput: 'slices' };
const DESIGN_SLICES_FORM: RepeatSpec = { backTo: 'build', countFrom: { artifact: 'design', format: 'impl-slices' } };
const PLAN_TITLES = ['Slice 1 of the feature', 'Slice 2 of the feature', 'Slice 3 of the feature'];
const REORDERED_BLOCK = '## Impl-slices\n\n### Impl-slice 2 — Second first\nAcceptance criteria: a\n\n### Impl-slice 1 — First second\nAcceptance criteria: b\n';
const implSlices = (titles: readonly string[]): string =>
  ['## Impl-slices', '', ...titles.flatMap((t, i) => [`### Impl-slice ${i + 1} — ${t}`, `Acceptance criteria: criterion ${i + 1}`, ''])].join('\n');

const relaunched = (): FlowManager => createFlowManager({ globalDir: tmp('repeat-sourcing-relaunch-global-') });

function relaunchedEntriesAcross(r: Rig): (RepeatEntry | null)[] {
  const named: (RepeatEntry | null)[] = [];
  for (let i = 0; i < MAX_STEPS && r.flow.state(r.repo).stepName === 'build'; i++) {
    named.push(relaunched().entryFor(r.repo, 'build'));
    r.flow.advance(r.repo);
    r.flow.advance(r.repo);
  }
  return named;
}

async function sourcedAtBuild(r: Rig, steps: Leave): Promise<void> {
  r.flow.start(r.repo);
  leave(r.driver.outputPath('design', 'steps'), steps);
  await r.driver.approve('design');
}

describe('Each repeated work turn names its entry', () => {
  it.each([1, 3])('a %i-entry JSON list names entry k of N with the k-th title on each group step', async (n) => {
    const r = rig(flowSpec(STEPS_LIST, ['design']), 'steps');
    r.flow.start(r.repo);
    expect(await playNamed(r, 'steps', { design: always(list(n)) })).toEqual(namedRun(['design'], distinctTitles(n)));
  });

  it('a 60-entry list names entries 1 to 50 of 50: N is the count after the clamp', async () => {
    const r = rig(flowSpec(STEPS_LIST, ['design']), 'steps');
    r.flow.start(r.repo);
    expect(await playNamed(r, 'steps', { design: always(list(60)) })).toEqual(namedRun(['design'], distinctTitles(60), 50));
  });

  it.each([
    ['in file order', exampleSlicePlan(3), PLAN_TITLES],
    ['numbered 2 then 1, where entry 1 is the heading numbered 2', REORDERED_BLOCK, ['Second first', 'First second']],
  ] as const)('an impl-slices block in any artifact names its headings %s', async (_name, text, titles) => {
    const r = rig(flowSpec(DESIGN_SLICES_FORM, ['design']), 'design');
    r.flow.start(r.repo);
    expect(await playNamed(r, 'design', { design: always(text) })).toEqual(namedRun(['design'], titles));
  });

  it.each([
    ['in file order', exampleSlicePlan(3), PLAN_TITLES],
    ['numbered 2 then 1, where entry 1 is the heading numbered 2', REORDERED_BLOCK, ['Second first', 'First second']],
  ] as const)("today's count_input form sourced from a plan names its headings %s", async (_name, text, titles) => {
    const r = rig(flowSpec(SLICES_INPUT_FORM, ['plan']), 'plan');
    r.flow.start(r.repo);
    expect(await playNamed(r, 'plan', { plan: always(text) })).toEqual(namedRun(['plan'], titles));
  });

  it("today's count_input form sourced from a 60-slice plan names entries 1 to 50 of 50", async () => {
    const r = rig(flowSpec(SLICES_INPUT_FORM, ['plan']), 'plan');
    r.flow.start(r.repo);
    const titles = Array.from({ length: 60 }, (_, i) => `Slice ${i + 1} of the feature`);
    expect(await playNamed(r, 'plan', { plan: always(exampleSlicePlan(60)) })).toEqual(namedRun(['plan'], titles, 50));
  });

  it('a title is named with each control character, line or paragraph separator, bidi override and zero-width character turned into a space, ZWJ and ZWNJ kept, and its spaces untrimmed', async () => {
    const fromJson = rig(flowSpec(STEPS_LIST, ['design']), 'steps');
    fromJson.flow.start(fromJson.repo);
    expect.soft(await playNamed(fromJson, 'steps', { design: always(jsonListText(['Parse\u2028the\u202Einput', 'Zero\u200Bwidth\u2066iso', 'a\u200Db\u200Cc', '  two  spaces  '])) })).toEqual(namedRun(['design'], ['Parse the input', 'Zero width iso', 'a\u200Db\u200Cc', '  two  spaces  ']));
    const fromBlock = rig(flowSpec(DESIGN_SLICES_FORM, ['design']), 'design');
    fromBlock.flow.start(fromBlock.repo);
    expect.soft(await playNamed(fromBlock, 'design', { design: always(implSlices(['Red \u001b[31mtitle', 'Plain'])) })).toEqual(namedRun(['design'], ['Red  [31mtitle', 'Plain']));
  });

  const CAPPED: readonly (readonly [string, string])[] = [
    ['x'.repeat(150), 'x'.repeat(100)],
    ['y'.repeat(100), 'y'.repeat(100)],
    [`${'a'.repeat(99)}\u{1F600}b`, `${'a'.repeat(99)}\u{1F600}`],
  ];

  it.each([
    ['a JSON list', STEPS_LIST, 'steps', jsonListText(CAPPED.map(([source]) => source))],
    ['an impl-slices block', DESIGN_SLICES_FORM, 'design', implSlices(CAPPED.map(([source]) => source))],
  ] as const)('from %s, a title over 100 characters is named by its first 100, one of exactly 100 whole, and an astral character at the cut is kept whole', async (_name, repeat, outputId, text) => {
    const r = rig(flowSpec(repeat, ['design']), outputId);
    r.flow.start(r.repo);
    expect(await playNamed(r, outputId, { design: always(text) })).toEqual(namedRun(['design'], CAPPED.map(([, shown]) => shown)));
  });

  it('a planted record whose titles hold an ESC sequence, a bidi override, 150 characters, a ZWJ and edge spaces names each cleaned and cut to 100, ZWJ and spaces kept', () => {
    const r = rig(flowSpec(STEPS_LIST, ['design']), 'steps');
    writeFileSync(join(r.repo, '.agent-terminal', 'flow-state.yaml'), `step: build\nstatus: in_progress\nrepeat_list:\n  count: 5\n  titles:\n    - "Red \\e[31mtitle"\n    - "a\\u202Eb"\n    - "${'x'.repeat(150)}"\n    - "a\\u200Db"\n    - "  two  spaces  "\n`);
    expect(relaunchedEntriesAcross(r)).toEqual([entry(1, 5, 'Red  [31mtitle'), entry(2, 5, 'a b'), entry(3, 5, 'x'.repeat(100)), entry(4, 5, 'a\u200Db'), entry(5, 5, '  two  spaces  ')]);
  });

  it('a planted record with fewer titles than its count names an entry only on the iterations that have a title', () => {
    const r = rig(flowSpec(STEPS_LIST, ['design']), 'steps');
    writeFileSync(join(r.repo, '.agent-terminal', 'flow-state.yaml'), 'step: build\nstatus: in_progress\nrepeat_list:\n  count: 3\n  titles:\n    - First\n');
    expect(relaunchedEntriesAcross(r)).toEqual([entry(1, 3, 'First'), null, null]);
  });

  it('50 titles of 100 four-byte characters each are saved within the flow-state read bound, and a relaunch names every one', async () => {
    const titles = Array.from({ length: 50 }, (_, i) => String.fromCodePoint(0x1f600 + i).repeat(100));
    const r = rig(flowSpec(STEPS_LIST, ['design']), 'steps');
    await sourcedAtBuild(r, jsonListText(titles));
    expect.soft(statSync(join(r.repo, '.agent-terminal', 'flow-state.yaml')).size).toBeLessThanOrEqual(MAX_FLOW_STATE_BYTES);
    expect.soft(relaunchedEntriesAcross(r)).toEqual(titles.map((t, i) => entry(i + 1, 50, t)));
  });

  it('a list of 200 titles of 100 four-byte characters keeps only the first 50 within the flow-state read bound, and a relaunch names entries 1 to 50 of 50', async () => {
    const titles = Array.from({ length: 200 }, (_, i) => String.fromCodePoint(0x1f600 + i).repeat(100));
    const r = rig(flowSpec(STEPS_LIST, ['design']), 'steps');
    await sourcedAtBuild(r, jsonListText(titles));
    expect.soft(statSync(join(r.repo, '.agent-terminal', 'flow-state.yaml')).size).toBeLessThanOrEqual(MAX_FLOW_STATE_BYTES);
    expect.soft(relaunchedEntriesAcross(r)).toEqual(titles.slice(0, 50).map((t, i) => entry(i + 1, 50, t)));
  });

  it('an edit to the list file outside a source approve leaves the named titles as they were sourced', async () => {
    const r = rig(flowSpec(STEPS_LIST, ['design']), 'steps');
    await sourcedAtBuild(r, list(3));
    leave(r.driver.outputPath('design', 'steps'), jsonListText(['Changed 1', 'Changed 2', 'Changed 3']));
    expect(await playNamed(r, 'steps', {})).toEqual(namedRun([], distinctTitles(3)));
  });

  it('a later source approve that sources nothing leaves the named titles as they were sourced', async () => {
    const r = rig(flowSpec(STEPS_LIST, ['design', 'redesign']), 'steps');
    r.flow.start(r.repo);
    expect(await playNamed(r, 'steps', { design: always(list(3)), redesign: always(NO_LIST) })).toEqual(namedRun(['design', 'redesign'], distinctTitles(3)));
  });

  it("a count_input that is not slices names no entry, even when a person's value equals the plan's slice count, beside a slices count_input that does", async () => {
    const byPerson = rig(flowSpec({ backTo: 'build', countInput: 'n' }, ['plan']), 'plan');
    byPerson.flow.start(byPerson.repo);
    byPerson.flow.provideInput(byPerson.repo, { n: '3' });
    expect.soft(await playNamed(byPerson, 'plan', { plan: always(exampleSlicePlan(3)) })).toEqual(unnamed(sequence(['plan'], 3)));
    const fromPlan = rig(flowSpec(SLICES_INPUT_FORM, ['plan']), 'plan');
    fromPlan.flow.start(fromPlan.repo);
    expect.soft(await playNamed(fromPlan, 'plan', { plan: always(exampleSlicePlan(3)) })).toEqual(namedRun(['plan'], PLAN_TITLES));
  });

  it('in the count_input form, a persisted slices input that differs from the recorded list names no entry and keeps its count, beside one that matches', () => {
    const record = 'repeat_list:\n  count: 2\n  titles:\n    - First\n    - Second\n';
    const plant = (slices: string): Rig => {
      const r = rig(flowSpec(SLICES_INPUT_FORM, ['design']), 'steps');
      writeFileSync(join(r.repo, '.agent-terminal', 'flow-state.yaml'), `step: build\nstatus: in_progress\ninputs:\n  slices: '${slices}'\n${record}`);
      return r;
    };
    expect.soft(relaunchedEntriesAcross(plant('3'))).toEqual([null, null, null]);
    expect.soft(relaunchedEntriesAcross(plant('2'))).toEqual([entry(1, 2, 'First'), entry(2, 2, 'Second')]);
  });
});

describe('No list, no entry line', () => {
  it('before any source approve a group step names no entry, beside a twin run whose source approve does name one', async () => {
    const unsourced = rig(flowSpec(STEPS_LIST, ['design']), 'steps');
    unsourced.flow.start(unsourced.repo);
    unsourced.flow.advance(unsourced.repo);
    const sourced = rig(flowSpec(STEPS_LIST, ['design']), 'steps');
    await sourcedAtBuild(sourced, list(3));
    expect({ unsourced: unsourced.flow.entryFor(unsourced.repo, 'build'), sourced: sourced.flow.entryFor(sourced.repo, 'build') }).toEqual({
      unsourced: null,
      sourced: entry(1, 3, distinctTitles(3)[0]),
    });
  });

  it('a count_input value a person supplies names no entry, after the plan source approve had named one', async () => {
    const r = rig(flowSpec(SLICES_INPUT_FORM, ['plan']), 'plan');
    r.flow.start(r.repo);
    leave(r.driver.outputPath('plan', 'plan'), exampleSlicePlan(3));
    await r.driver.approve('plan');
    const fromPlan = r.flow.entryFor(r.repo, 'build');
    r.flow.provideInput(r.repo, { slices: '3' });
    expect({ fromPlan, byPerson: r.flow.entryFor(r.repo, 'build') }).toEqual({ fromPlan: entry(1, 3, PLAN_TITLES[0]), byPerson: null });
  });

  it('a value a person supplies for another input keeps the entry the plan source approve named', async () => {
    const r = rig(flowSpec(SLICES_INPUT_FORM, ['plan']), 'plan');
    r.flow.start(r.repo);
    leave(r.driver.outputPath('plan', 'plan'), exampleSlicePlan(3));
    await r.driver.approve('plan');
    r.flow.provideInput(r.repo, { other: 'x' });
    expect(r.flow.entryFor(r.repo, 'build')).toEqual(entry(1, 3, PLAN_TITLES[0]));
  });

  const toDone = (r: Rig): void => {
    for (let i = 0; i < MAX_STEPS && r.flow.state(r.repo).status !== 'done'; i++) r.flow.advance(r.repo);
  };
  const CLEARINGS: readonly (readonly [string, (r: Rig) => void])[] = [
    [
      'a restart',
      (r) => {
        toDone(r);
        r.flow.restart(r.repo);
      },
    ],
    [
      'a terminate',
      (r) => {
        r.flow.terminate(r.repo);
        r.flow.start(r.repo);
      },
    ],
    [
      'a revert to not-started',
      (r) => {
        r.flow.revertStep(r.repo, 'build');
        r.flow.revertStep(r.repo, 'design');
        r.flow.start(r.repo);
      },
    ],
  ];

  it.each(CLEARINGS)('after %s, a group step names no entry until the next source approve, though it named one before', async (_name, clear) => {
    const r = rig(flowSpec(STEPS_LIST, ['design']), 'steps');
    await sourcedAtBuild(r, list(3));
    const before = r.flow.entryFor(r.repo, 'build');
    clear(r);
    r.flow.advance(r.repo);
    expect({ before, after: [r.flow.state(r.repo).stepName, r.flow.entryFor(r.repo, 'build')] }).toEqual({ before: entry(1, 3, distinctTitles(3)[0]), after: ['build', null] });
  });

  it('a revert to an earlier step keeps the entry', async () => {
    const r = rig(flowSpec(STEPS_LIST, ['design']), 'steps');
    await sourcedAtBuild(r, list(3));
    r.flow.revertStep(r.repo, 'build');
    r.flow.advance(r.repo);
    expect([r.flow.state(r.repo).stepName, r.flow.entryFor(r.repo, 'build')]).toEqual(['build', entry(1, 3, distinctTitles(3)[0])]);
  });
});

describe('Steps outside the group get no entry line', () => {
  it('the steps before back_to and the finish loop step after the repeat name no entry, while the group steps of the same run name the latest source approve\'s titles', async () => {
    const r = rig(flowSpec(STEPS_LIST, ['design', 'redesign']), 'steps');
    r.flow.start(r.repo);
    const named = await playNamed(r, 'steps', { design: always(list(2)), redesign: always(jsonListText(['Re 1', 'Re 2'])) });
    expect(named.filter(([step]) => step !== 'done')).toEqual(namedRun(['design', 'redesign'], ['Re 1', 'Re 2']).filter(([step]) => step !== 'done'));
  });
});

describe('A relaunch resumes the iteration', () => {
  it('a relaunched manager mid-iteration 2 of 3 resumes on iteration 2 and names entry 2 of 3 with the same title', async () => {
    const r = rig(flowSpec(STEPS_LIST, ['design']), 'steps');
    await sourcedAtBuild(r, list(3));
    await r.driver.approve('build');
    await r.driver.approve('check');
    const fresh = relaunched();
    expect({ slice: fresh.currentSlice(r.repo), at: fresh.state(r.repo).stepName, entry: fresh.entryFor(r.repo, 'build') }).toEqual({
      slice: 2,
      at: 'build',
      entry: entry(2, 3, distinctTitles(3)[1]),
    });
  });

  it('a 60-entry list resumes with count 50 and a title for each of positions 1 to 50', async () => {
    const r = rig(flowSpec(STEPS_LIST, ['design']), 'steps');
    await sourcedAtBuild(r, list(60));
    expect(relaunchedEntriesAcross(r)).toEqual(distinctTitles(50).map((t, i) => entry(i + 1, 50, t)));
  });
});

describe('Runs started before this change resume', () => {
  it('a pre-change flow-state document resumes on its iteration with its count and no entry, and the next source approve names that list', async () => {
    const r = rig(flowSpec(SLICES_INPUT_FORM, ['plan'], true), 'plan');
    writeFileSync(join(r.repo, '.agent-terminal', 'flow-state.yaml'), "step: build\nstatus: in_progress\ninputs:\n  slices: '3'\nrepeat_counts:\n  check: 2\n");
    const resumed = { slice: r.flow.currentSlice(r.repo), entry: r.flow.entryFor(r.repo, 'build') };
    leave(r.driver.outputPath('build', 'plan'), exampleSlicePlan(3));
    await r.driver.approve('build');
    const afterSource = r.flow.entryFor(r.repo, 'check');
    const rest = await play(r, 'plan', {});
    expect({ resumed, afterSource, rest }).toEqual({
      resumed: { slice: 2, entry: null },
      afterSource: entry(2, 3, PLAN_TITLES[1]),
      rest: ['check', 'build', 'check', 'finish', 'done'],
    });
  });
});
