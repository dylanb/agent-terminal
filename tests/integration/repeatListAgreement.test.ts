import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readLoopArtifact } from '../../src/main/appLoopPaths';
import { runCheckRepeatList } from '../../src/main/checkRepeatList';
import { createFlowManager } from '../../src/main/flow';
import { createRepeatSourcer } from '../../src/main/repeatSourcing';
import { createFedPipes } from '../helpers/fedPipe';
import { flowLocations, writeFlow, writeLoopDef, type FlowSpec } from '../helpers/flowFixtures';
import { JSON_LIST_CASES } from '../helpers/jsonListCases';
import { LIST_FILE_CASES, WELL_FORMED_ENTRIES } from '../helpers/jsonListFiles';
import { createApproveDriver } from '../helpers/repeatApprove';

const dirs: string[] = [];
const pipes = createFedPipes();
afterEach(async () => {
  await pipes.reap();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (prefix: string): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};

const COUNT_CAP = 50;
const SOURCE_LOOP = 'source-loop';
const WORK_LOOP = 'work-loop';

interface AgreementCase {
  name: string;
  list: string;
  lay: (file: string) => void;
  sources: number | null;
}

const text = (content: string | Buffer) => (file: string): void => writeFileSync(file, content);

const CASES: readonly AgreementCase[] = [
  ...JSON_LIST_CASES.map((c): AgreementCase => ({
    name: c.name,
    list: c.list,
    lay: text(c.text),
    sources: c.expected.wellFormed ? Math.min(c.expected.titles.length, COUNT_CAP) : null,
  })),
  ...LIST_FILE_CASES.map((c): AgreementCase => ({
    name: c.name,
    list: 'steps',
    lay: (file) => c.lay(file, pipes),
    sources: c.reads === 'well-formed' ? WELL_FORMED_ENTRIES : null,
  })),
];

function flowSpec(list: string): FlowSpec {
  return {
    name: 'repeat-agreement',
    steps: [
      { id: 'design', kind: 'loop', loop: SOURCE_LOOP },
      { id: 'build', kind: 'loop', loop: WORK_LOOP },
      { id: 'check', kind: 'loop', loop: WORK_LOOP, repeat: { backTo: 'build', countFrom: { artifact: 'steps', format: 'json-list', list } } },
      { id: 'finish', kind: 'loop', loop: WORK_LOOP },
      { id: 'done', kind: 'manual' },
    ],
  };
}

async function judged(c: AgreementCase): Promise<{ engine: string | null; checkPasses: boolean }> {
  const repo = tmp('repeat-agreement-repo-');
  const loopsRoot = tmp('repeat-agreement-loops-');
  const gate = [{ option: 'approve' }];
  writeLoopDef(loopsRoot, SOURCE_LOOP, { artifact: 'steps', outputs: { steps: 'steps.json' }, gate });
  writeLoopDef(loopsRoot, WORK_LOOP, { outputs: { result: 'work-result.md' }, gate });
  const spec = flowSpec(c.list);
  writeFlow(flowLocations.repoLocal(repo), spec);
  const flow = createFlowManager({ globalDir: tmp('repeat-agreement-global-') });
  const sourceSliceCount = createRepeatSourcer({
    flow,
    readArtifact: readLoopArtifact,
  });
  const driver = createApproveDriver({
    repoDir: repo,
    flow,
    spec,
    loops: { tiers: { operator: loopsRoot, appBundled: loopsRoot, retired: null }, repoDir: repo },
    sourceSliceCount,
  });
  flow.start(repo);
  const file = driver.outputPath('design', 'steps');
  mkdirSync(dirname(file), { recursive: true });
  c.lay(file);
  await driver.approve('design');
  const entry = flow.entryFor(repo, 'build');
  const checked = runCheckRepeatList([file, c.list], { cwd: () => repo });
  return { engine: entry === null ? null : `entry ${entry.position} of ${entry.count}`, checkPasses: checked.exitCode === 0 };
}

describe('The check and the engine agree', () => {
  it('for every file of the self-check fixtures, the command passes exactly when a source approve of it sources a count', async () => {
    const rows: { name: string; expected: number | null; engine: string | null; checkPasses: boolean }[] = [];
    for (const c of CASES) rows.push({ name: c.name, expected: c.sources, ...(await judged(c)) });
    const table = <T>(pick: (row: (typeof rows)[number]) => T): Record<string, T> => Object.fromEntries(rows.map((row) => [row.name, pick(row)]));
    expect.soft(table((row) => row.engine), 'the engine sources the count the oracle names').toEqual(table((row) => (row.expected === null ? null : `entry 1 of ${row.expected}`)));
    expect(table((row) => row.checkPasses)).toEqual(table((row) => row.engine !== null));
  });
});
