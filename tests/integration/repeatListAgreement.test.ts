// #278 — `--check-repeat-list` and the engine judge a file alike: for every file of the self-check's fixtures, the
// command passes exactly when a source approve of that same file, through the real approve path, the real sourcer
// and a real flow manager, sources a count. A count is sourced when the first group step then names entry 1 of N:
// the step sequence alone cannot tell a sourced count of 1 from the floor of 1.

import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_LOOP_ARTIFACT_BYTES, readLoopArtifact } from '../../src/main/appLoopPaths';
import { runCheckRepeatList } from '../../src/main/checkRepeatList';
import { createFlowManager, loadFlowDefinition } from '../../src/main/flow';
import { createRepeatSourcer } from '../../src/main/repeatSourcing';
import { createFedPipes } from '../helpers/fedPipe';
import { flowLocations, writeFlow, writeLoopDef, type FlowSpec } from '../helpers/flowFixtures';
import { JSON_LIST_CASES, distinctTitles, jsonListText } from '../helpers/jsonListCases';
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

/** The most times a group runs (§28.4.1), written here rather than read from the engine. */
const COUNT_CAP = 50;
const SOURCE_LOOP = 'source-loop';
const WORK_LOOP = 'work-loop';
const WELL_FORMED = jsonListText(distinctTitles(3));

/** One file of the self-check's fixtures: the list key it is checked under, how to lay it at a path, and the count
 *  the oracle says it sources (null for none). */
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
  { name: 'a well-formed file after a UTF-8 byte-order mark', list: 'steps', lay: text(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(WELL_FORMED)])), sources: 3 },
  { name: 'an absent file', list: 'steps', lay: () => {}, sources: null },
  { name: 'a directory', list: 'steps', lay: (file) => mkdirSync(file), sources: null },
  {
    name: 'a symlink to a well-formed file',
    list: 'steps',
    lay: (file) => {
      const target = join(dirname(file), 'link-target.json');
      writeFileSync(target, WELL_FORMED);
      symlinkSync(target, file);
    },
    sources: null,
  },
  { name: 'a file over the 16 MiB read bound', list: 'steps', lay: text(`${WELL_FORMED.slice(0, -1)}, "pad": "${'x'.repeat(MAX_LOOP_ARTIFACT_BYTES)}"}`), sources: null },
  {
    name: 'a file that is not valid UTF-8',
    list: 'steps',
    lay: text(Buffer.concat([Buffer.from('{"steps": [{"title": "'), Buffer.from([0xc3, 0x28]), Buffer.from('"}]}')])),
    sources: null,
  },
  { name: 'a named pipe fed a well-formed list', list: 'steps', lay: (file) => pipes.at(file, WELL_FORMED), sources: null },
  ...(process.getuid?.() === 0
    ? []
    : [{
      name: 'a file its reader may not read (mode 000)',
      list: 'steps',
      lay: (file: string) => {
        writeFileSync(file, WELL_FORMED);
        chmodSync(file, 0o000);
      },
      sources: null,
    }]),
];

/** `design` outputs `steps`; `build` and `check` are the group, `check` counting from `steps` under `list`. */
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

/** What a fresh run makes of the case's file at its source approve, and what the command makes of the same file. */
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
    repeatOf: (repoDir) => {
      const load = loadFlowDefinition(repoDir);
      return load.ok ? load.definition.steps.find((s) => s.repeat !== undefined)?.repeat : undefined;
    },
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
