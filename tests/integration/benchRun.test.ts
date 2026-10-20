import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { createBenchFixtureBuilder, type BenchFixtureBuilder } from '../helpers/benchFixtureBuilder';
import { createBenchRoots, type BenchRoots } from '../helpers/benchRoots';
import { createFakeBenchGithub, FAKE_BENCH_REPOSITORY, FAKE_LABEL_FAILURE } from '../helpers/benchFakeGithub';
import { createFakeBenchClock, createFakeLauncher } from '../helpers/benchFakeLauncher';
import {
  capturedSetup,
  FIXTURE_ARTIFACTS,
  FIXTURE_INPUTS,
  FIXTURE_REPEAT_COUNTS,
  handFields,
  preparedState,
  readTree,
  runRequest,
  V3_FLOW,
  V3_FLOW_FILE,
  worktreeCount,
  type PreparedState,
} from '../helpers/benchRunSetup';
import { runBench, type BenchFlowRef, type BenchRunResult } from '../../src/main/benchRun';
import { benchRootDir } from '../../src/main/benchPrepare';
import { createRunResolver } from '../../src/main/runResolver';
import { createFlowStateStore } from '../../src/main/flowState';
import { catalogEntryDefFile } from '../../src/main/flow';
import { APP_LOOP_DIR_SEGMENTS, ARTIFACTS_SUBDIR } from '../../src/main/appLoopPaths';
import { loadTodoTemplateFile, todoTemplateFile, todoTemplatesDir } from '../../src/main/todoTemplate';

// #180 — `bench run` over real git with a fake GitHub and a fake app: what each run's working folder holds when
// its app opens, the confinement of the restore, the `bench-run` label, and N runs one after another.

let b: BenchFixtureBuilder;
let roots: BenchRoots;
afterEach(() => {
  b?.cleanup();
  roots?.cleanup();
});

function fresh(): void {
  b = createBenchFixtureBuilder();
  roots = createBenchRoots();
}

const isInside = (parent: string, child: string): boolean => {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep);
};
const codeOf = (r: BenchRunResult): string | null => (r.ok ? null : r.code);
const copies = (writes: string[]): string[] => writes.filter((w) => w.startsWith('copyIssue'));

/** The state the fixture's run should open on: span `red`, the fixture's documents, inputs and loop position,
 *  and the run's copy (the fake's first, 501) as the ticket. */
const expectedState = (commit: string): PreparedState => ({
  head: commit,
  onNewBranch: true,
  flowState: { step: 'red', status: 'not_started', inputs: { ...FIXTURE_INPUTS, ticket: '501' }, repeatCounts: FIXTURE_REPEAT_COUNTS },
  flow: 'feature-dev-v3',
  binding: { source: 'catalog', tier: 'repo', id: expect.any(String) },
  artifacts: FIXTURE_ARTIFACTS,
});

/** The bound catalog entry's flow file in `workingFolder` and its `TEMPLATE_REF` todo template, as bytes; null
 *  when resolution bound no entry. */
function installedFlow(workingFolder: string, appHome: string): { flow: string; template: string | null } | null {
  const { binding } = createRunResolver(appHome)(workingFolder);
  if (binding?.source !== 'catalog') return null;
  const def = catalogEntryDefFile(workingFolder, binding.id);
  return { flow: readFileSync(def, 'utf8'), template: loadTodoTemplateFile(todoTemplatesDir(dirname(def)), TEMPLATE_REF) };
}

const TEMPLATE_REF = 'bench-marker';
const TEMPLATE = '- bench marker item\n';

/** The app's own files in `workingFolder` and the working folder's `.gitignore` against its committed bytes. */
function gitignoreState(workingFolder: string, commit: string): { unchanged: boolean; clean: string; appOwned: string[] } {
  return {
    unchanged: readFileSync(join(workingFolder, '.gitignore'), 'utf8') === b.git(workingFolder, ['show', `${commit}:.gitignore`]) + '\n',
    clean: b.git(workingFolder, ['status', '--porcelain']),
    appOwned: Object.keys(readTree(join(workingFolder, '.agent-terminal'))).filter((k) => k.split('/').includes('.gitignore')),
  };
}

/** `feature-dev-v3` with bytes of its own, so a run that installs the catalog's copy instead shows. */
const EDITED_V3_FLOW = `${V3_FLOW}# bench path-form marker\n`;

describe('preparing a run', () => {
  it.each([
    {
      form: 'catalog id',
      source: (repo: string): { flow: BenchFlowRef; bytes: string; home: string } => ({ flow: { kind: 'id', id: 'feature-dev-v3' }, bytes: V3_FLOW, home: dirname(catalogEntryDefFile(repo, 'feature-dev-v3')) }),
    },
    {
      form: 'path',
      source: (): { flow: BenchFlowRef; bytes: string; home: string } => {
        const home = b.outsideDir('bench-flow');
        writeFileSync(join(home, 'flow.yaml'), EDITED_V3_FLOW);
        return { flow: { kind: 'path', file: join(home, 'flow.yaml') }, bytes: EDITED_V3_FLOW, home };
      },
    },
  ])('opens the app on a working folder at the fixture\'s commit holding its state and the named flow\'s files, its .gitignore untouched, on a first-run app home, the flow named by $form', async ({ source }) => {
    fresh();
    const s = await capturedSetup(b, roots);
    const { flow, bytes, home } = source(s.repo);
    mkdirSync(todoTemplatesDir(home), { recursive: true });
    writeFileSync(join(todoTemplatesDir(home), todoTemplateFile(TEMPLATE_REF)), TEMPLATE);
    rmSync(join(roots.appHome, '.agent-terminal'), { recursive: true, force: true });
    let seen: { state: PreparedState; installed: ReturnType<typeof installedFlow>; gitignore: ReturnType<typeof gitignoreState> } | undefined;
    const launcher = createFakeLauncher({
      inspect: (launch) =>
        (seen = {
          state: preparedState(b, launch.workingFolder, roots.appHome),
          installed: installedFlow(launch.workingFolder, roots.appHome),
          gitignore: gitignoreState(launch.workingFolder, s.commit),
        }),
    });

    await runBench(runRequest(s, roots, { flow }, { launcher }));

    expect(seen).toEqual({ state: expectedState(s.commit), installed: { flow: bytes, template: TEMPLATE }, gitignore: { unchanged: true, clean: '', appOwned: [] } });
  });

  it('refuses with the confinement code a flow whose todo-templates folder is a symlink, copying no issue and launching nothing', async () => {
    fresh();
    const s = await capturedSetup(b, roots);
    const home = b.outsideDir('bench-flow-linked');
    writeFileSync(join(home, 'flow.yaml'), V3_FLOW);
    const elsewhere = b.outsideDir('bench-flow-linked-templates');
    writeFileSync(join(elsewhere, todoTemplateFile(TEMPLATE_REF)), TEMPLATE);
    symlinkSync(elsewhere, todoTemplatesDir(home));
    const github = createFakeBenchGithub();
    const launcher = createFakeLauncher();

    const result = await runBench(runRequest(s, roots, { flow: { kind: 'path', file: join(home, 'flow.yaml') } }, { github, launcher }));

    expect({ code: codeOf(result), copies: copies(github.writes), launches: launcher.launches.length }).toEqual({ code: 'restore-escapes', copies: [], launches: 0 });
  });

  it('names the working folder by its real path when the app home is reached through a symlink', async () => {
    fresh();
    const s = await capturedSetup(b, roots);
    const link = join(b.outsideDir('bench-home-link'), 'home');
    symlinkSync(roots.appHome, link);
    const launcher = createFakeLauncher();

    await runBench(runRequest(s, roots, { appHome: link }, { launcher }));

    const realHome = realpathSync(roots.appHome);
    expect(launcher.launches.map((l) => ({ real: existsSync(l.workingFolder) && l.workingFolder === realpathSync(l.workingFolder), underHome: isInside(realHome, l.workingFolder) }))).toEqual([
      { real: true, underHome: true },
    ]);
  });

  it('prepares from a hand-written fixture exactly as from a captured one with the same contents, the repository in any case', async () => {
    fresh();
    const s = await capturedSetup(b, roots);
    const hand = join(b.outsideDir('bench-hand'), 'fx');
    b.writeHandFixture(hand, { ...handFields(s.commit), issue: { repository: 'github.com/Bench-Owner/Bench-Repo', number: 180 } }, FIXTURE_ARTIFACTS);
    const states: Record<string, PreparedState | undefined> = {};
    const clock = createFakeBenchClock();
    for (const [name, fixtureDir] of [['captured', s.fixture], ['handWritten', hand]] as const) {
      const launcher = createFakeLauncher({ inspect: (launch) => (states[name] = preparedState(b, launch.workingFolder, roots.appHome)) });
      await runBench(runRequest({ repo: s.repo, fixture: fixtureDir }, roots, {}, { launcher, clock, github: createFakeBenchGithub() }));
    }

    expect(states).toEqual({ captured: expectedState(s.commit), handWritten: expectedState(s.commit) });
  });
});

describe('the restore is confined to the run\'s working folder', () => {
  type Case = { name: string; arrange: () => { fixture: string; repo: string; outside: () => unknown; outsideBefore: unknown } };
  const cases: Case[] = [
    {
      name: 'a fixture artifact that links to a file outside the fixture',
      arrange: () => {
        const { dir, commit } = b.makeRepository('bench-confine-a');
        b.seedFlow(dir, 'feature-dev-v3', V3_FLOW);
        const fixture = join(b.outsideDir('bench-confine-a-fx'), 'fx');
        b.writeHandFixture(fixture, handFields(commit), FIXTURE_ARTIFACTS);
        const { outsideFile, sentinel } = b.plantEscapeLink(join(fixture, 'artifacts', 'escape.md'));
        return { fixture, repo: dir, outside: () => readFileSync(outsideFile, 'utf8'), outsideBefore: sentinel };
      },
    },
    {
      name: 'a fixture commit that makes the loop artifacts directory a link out of the tree',
      arrange: () => {
        const { dir } = b.makeRepository('bench-confine-b');
        const outsideDir = b.outsideDir('bench-confine-b-out');
        b.git(dir, ['checkout', '-q', '-b', 'hostile']);
        const commit = b.commitTrackedSymlink(dir, [...APP_LOOP_DIR_SEGMENTS, ARTIFACTS_SUBDIR].join('/'), outsideDir);
        b.git(dir, ['checkout', '-q', 'main']);
        b.seedFlow(dir, 'feature-dev-v3', V3_FLOW);
        const fixture = join(b.outsideDir('bench-confine-b-fx'), 'fx');
        b.writeHandFixture(fixture, handFields(commit), FIXTURE_ARTIFACTS);
        return { fixture, repo: dir, outside: () => readTree(outsideDir), outsideBefore: {} };
      },
    },
    {
      name: 'a fixture commit that tracks .agent-terminal itself as a link out of the tree',
      arrange: () => {
        const { dir } = b.makeRepository('bench-confine-c');
        const outsideDir = b.outsideDir('bench-confine-c-out');
        b.git(dir, ['checkout', '-q', '-b', 'hostile']);
        const commit = b.commitTrackedSymlink(dir, APP_LOOP_DIR_SEGMENTS[0], outsideDir);
        b.git(dir, ['checkout', '-q', 'main']);
        b.seedFlow(dir, 'feature-dev-v3', V3_FLOW);
        const fixture = join(b.outsideDir('bench-confine-c-fx'), 'fx');
        b.writeHandFixture(fixture, handFields(commit), FIXTURE_ARTIFACTS);
        return { fixture, repo: dir, outside: () => readdirSync(outsideDir), outsideBefore: [] };
      },
    },
  ];

  it.each(cases)('stops with the confinement code for $name, copying no issue, writing nothing outside and opening no app', async ({ arrange }) => {
    fresh();
    const { fixture, repo, outside, outsideBefore } = arrange();
    const github = createFakeBenchGithub();
    const launcher = createFakeLauncher();

    const result = await runBench(runRequest({ repo, fixture }, roots, { flow: { kind: 'path', file: V3_FLOW_FILE } }, { github, launcher }));

    expect({ code: codeOf(result), copies: copies(github.writes), launches: launcher.launches.length, outside: outside() }).toEqual({
      code: 'restore-escapes',
      copies: [],
      launches: 0,
      outside: outsideBefore,
    });
  });

  it('stops the whole command at the first run whose preparation fails, naming the kept run folder and preparing no later run', async () => {
    fresh();
    // The link is in the fixture commit's tree, so only run 1's own working folder can expose it.
    const { fixture, repo } = cases[1].arrange();
    const github = createFakeBenchGithub();
    const launcher = createFakeLauncher({ scripts: [{}, {}] });

    const result = await runBench(runRequest({ repo, fixture }, roots, { flow: { kind: 'path', file: V3_FLOW_FILE }, runs: '2' }, { github, launcher }));

    const realHome = realpathSync(roots.appHome);
    expect({
      code: codeOf(result),
      copies: copies(github.writes),
      launches: launcher.launches.length,
      worktrees: worktreeCount(b, repo),
      kept: result.runFolders.map((f) => existsSync(f) && isInside(realHome, realpathSync(f))),
    }).toEqual({ code: 'restore-escapes', copies: [], launches: 0, worktrees: 2, kept: [true] });
  });
});

describe('a run that cannot be prepared', () => {
  it('stops with prepare-failed when the run\'s worktree cannot be added, copying no issue and launching nothing', async () => {
    fresh();
    const s = await capturedSetup(b, roots);
    b.git(s.repo, ['branch', 'bench/s1/run-1']);
    const github = createFakeBenchGithub();
    const launcher = createFakeLauncher();

    const result = await runBench(runRequest(s, roots, {}, { github, launcher, clock: createFakeBenchClock(['s1']) }));

    expect({ code: codeOf(result), copies: copies(github.writes), launches: launcher.launches.length, kept: result.runFolders.map((f) => existsSync(f)) }).toEqual({
      code: 'prepare-failed',
      copies: [],
      launches: 0,
      kept: [true],
    });
  });

  it.skipIf(process.getuid?.() === 0)('stops with prepare-failed when a later run\'s folder cannot be made, naming only folders that exist', async () => {
    fresh();
    const s = await capturedSetup(b, roots);
    let stampDir: string | null = null;
    const launcher = createFakeLauncher({
      scripts: [{}, {}],
      inspect: (launch) => {
        stampDir = dirname(dirname(launch.spanEndFile));
        chmodSync(stampDir, 0o555);
      },
    });

    try {
      const result = await runBench(runRequest(s, roots, { runs: '2' }, { launcher }));

      expect({ code: codeOf(result), launches: launcher.launches.length, kept: result.runFolders.map((f) => existsSync(f)) }).toEqual({
        code: 'prepare-failed',
        launches: 1,
        kept: [true],
      });
    } finally {
      if (stampDir !== null) chmodSync(stampDir, 0o755);
    }
  });

  it('names the issue copy it made when the run\'s flow state then cannot be seeded', async () => {
    fresh();
    const s = await capturedSetup(b, roots);
    const runFolder = join(benchRootDir(realpathSync(roots.appHome)), 's1', 'run-1');
    const github = createFakeBenchGithub({
      onCopy: () => {
        const appDir = join(runFolder, 'bench-s1-run-1', '.agent-terminal');
        mkdirSync(appDir, { recursive: true });
        writeFileSync(join(appDir, 'flow-state.yaml'), ': not a flow state [');
      },
    });
    const launcher = createFakeLauncher();

    const result = await runBench(runRequest(s, roots, {}, { github, launcher, clock: createFakeBenchClock(['s1']) }));

    expect({ code: codeOf(result), reason: result.ok ? null : result.reason, launches: launcher.launches.length }).toEqual({
      code: 'prepare-failed',
      reason: expect.stringMatching(/#501\b/),
      launches: 0,
    });
  });
});

describe('the bench-run label', () => {
  it.each([
    ['missing', 'absent', 'created'],
    ['already there', 'present', 'existed'],
  ] as const)('is checked once, after the refusals and before the first issue copy, when it is %s', async (_, label, answer) => {
    fresh();
    const s = await capturedSetup(b, roots);
    const github = createFakeBenchGithub({ label });

    await runBench(runRequest(s, roots, { runs: '2' }, { github, launcher: createFakeLauncher({ scripts: [{}, {}] }) }));

    expect(github.writes).toEqual([
      `ensureBenchRunLabel ${FAKE_BENCH_REPOSITORY} → ${answer}`,
      `copyIssue ${FAKE_BENCH_REPOSITORY}#180 → 501`,
      `copyIssue ${FAKE_BENCH_REPOSITORY}#180 → 502`,
    ]);
  });

  it('stops the command with its code when it cannot be created: no copy, no working folder, no app', async () => {
    fresh();
    const s = await capturedSetup(b, roots);
    const github = createFakeBenchGithub({ label: 'create-fails' });
    const launcher = createFakeLauncher({ scripts: [{}, {}] });

    const result = await runBench(runRequest(s, roots, { runs: '2' }, { github, launcher }));

    expect({ code: codeOf(result), reason: result.ok ? null : result.reason, copies: copies(github.writes), launches: launcher.launches.length, appHome: readdirSync(roots.appHome), worktrees: worktreeCount(b, s.repo) }).toEqual({
      code: 'label-failed',
      reason: FAKE_LABEL_FAILURE,
      copies: [],
      launches: 0,
      appHome: [],
      worktrees: 1,
    });
  });
});

describe('N runs', () => {
  it('runs three one after another, each prepared only after the previous app exited, in its own folder on its own branch', async () => {
    fresh();
    const s = await capturedSetup(b, roots);
    const events: string[] = [];
    const github = createFakeBenchGithub({ events });
    const worktreesAtOpen: number[] = [];
    const tickets: (string | undefined)[] = [];
    // Each app stays open far longer than a run's preparation takes, so a runner that does not wait for it to exit
    // copies the next issue before `exit k`.
    const scripts = Array.from({ length: 3 }, () => ({ holdMs: 500 }));
    const launcher = createFakeLauncher({ events, scripts, inspect: (launch) => {
        worktreesAtOpen.push(worktreeCount(b, s.repo));
        tickets.push(createFlowStateStore(launch.workingFolder).read()?.inputs?.ticket);
      },
    });

    const result = await runBench(runRequest(s, roots, { runs: '3' }, { github, launcher }));

    const runs = result.runFolders.map((folder, i) => {
      const wf = launcher.launches[i]?.workingFolder ?? '';
      return {
        outsideRepo: !isInside(s.repo, folder),
        workingFolderInside: isInside(realpathSync(folder), wf),
        documents: readTree(join(wf, ...APP_LOOP_DIR_SEGMENTS, ARTIFACTS_SUBDIR)),
      };
    });
    const branches = launcher.launches.map((l) => b.git(l.workingFolder, ['rev-parse', '--abbrev-ref', 'HEAD']));
    expect({ events, worktreesAtOpen, tickets, distinctFolders: new Set(result.runFolders).size, distinctBranches: new Set(branches).size, runs }).toEqual({
      events: [
        `ensureBenchRunLabel ${FAKE_BENCH_REPOSITORY} → created`,
        `copyIssue ${FAKE_BENCH_REPOSITORY}#180 → 501`,
        'open 1',
        'exit 1',
        `copyIssue ${FAKE_BENCH_REPOSITORY}#180 → 502`,
        'open 2',
        'exit 2',
        `copyIssue ${FAKE_BENCH_REPOSITORY}#180 → 503`,
        'open 3',
        'exit 3',
      ],
      // The repository's own working folder plus one per run prepared so far: run k+1's is not made before app k exits.
      worktreesAtOpen: [2, 3, 4],
      tickets: ['501', '502', '503'],
      distinctFolders: 3,
      distinctBranches: 3,
      runs: Array.from({ length: 3 }, () => ({ outsideRepo: true, workingFolderInside: true, documents: FIXTURE_ARTIFACTS })),
    });
  });

  it('stops at the run whose issue copy fails, keeping the earlier run and that run\'s folder and preparing no later run', async () => {
    fresh();
    const s = await capturedSetup(b, roots);
    const events: string[] = [];
    const github = createFakeBenchGithub({ events, failCopyAt: 2 });
    const launcher = createFakeLauncher({ events, scripts: [{}, {}, {}] });

    const result = await runBench(runRequest(s, roots, { runs: '3' }, { github, launcher }));

    const realHome = realpathSync(roots.appHome);
    expect({
      code: codeOf(result),
      events,
      worktrees: worktreeCount(b, s.repo),
      kept: result.runFolders.map((f) => existsSync(f) && isInside(realHome, realpathSync(f))),
    }).toEqual({
      code: 'issue-copy-failed',
      events: [
        `ensureBenchRunLabel ${FAKE_BENCH_REPOSITORY} → created`,
        `copyIssue ${FAKE_BENCH_REPOSITORY}#180 → 501`,
        'open 1',
        'exit 1',
        `copyIssue ${FAKE_BENCH_REPOSITORY}#180 → failed`,
      ],
      worktrees: 3,
      kept: [true, true],
    });
  });

  it('refuses a second command whose stamp names the first one\'s runs, leaving them as they were', async () => {
    fresh();
    const s = await capturedSetup(b, roots);
    await runBench(runRequest(s, roots, {}, { clock: createFakeBenchClock(['20261020T120000']) }));
    const before = { home: readTree(roots.appHome), branches: b.git(s.repo, ['branch', '--list']) };
    const launcher = createFakeLauncher();
    const github = createFakeBenchGithub();

    const second = await runBench(runRequest(s, roots, {}, { clock: createFakeBenchClock(['20261020T120000']), launcher, github }));

    expect({ code: codeOf(second), copies: copies(github.writes), launches: launcher.launches.length, home: readTree(roots.appHome), branches: b.git(s.repo, ['branch', '--list']) }).toEqual({
      code: 'stamp-exists',
      copies: [],
      launches: 0,
      ...before,
    });
  });
});
