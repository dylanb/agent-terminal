import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { createBenchFixtureBuilder, type BenchFixtureBuilder } from '../helpers/benchFixtureBuilder';
import { createBenchRoots, type BenchRoots } from '../helpers/benchRoots';
import { createFakeBenchGithub, FAKE_BENCH_REPOSITORY, FAKE_FIRST_COPY, FAKE_LABEL_FAILURE } from '../helpers/benchFakeGithub';
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
import { flowDefinitionRevision, promptRevision } from '../../src/main/benchRevision';
import { createAuditRecorder } from '../../src/main/auditRecorder';
import { auditRepoDir, auditRootDir } from '../../src/main/auditPaths';
import { baselineForBranch, readBaselineCommit } from '../../src/main/appLoopState';
import { currentGitBranch } from '../../src/main/gitBranch';
import { resolveExampleLoopsV2Dir } from '../../src/main/exampleAssets';
import { userConfigLoopsV2Dir } from '../../src/main/userConfig';
import { BENCH_RUN_AUDIT_DIR, BENCH_RUN_RECORD_FILE, BENCH_RUN_RECORD_SCHEMA, parseBenchRunRecord, type BenchRunRecord } from '../../src/shared/benchRunRecord';
import { benchRootDir } from '../../src/main/benchPrepare';
import { createRunResolver } from '../../src/main/runResolver';
import { createFlowStateStore } from '../../src/main/flowState';
import { catalogEntryDefFile, FLOWS_CATALOG_SUBDIR, readUntrustedFlowDefinition } from '../../src/main/flow';
import { FLOW_HOME_SUBDIR } from '../../src/main/flowHome';
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

  it("prepares and launches when the invoking repository's owner and name are spelled with capitals", async () => {
    fresh();
    const s = await capturedSetup(b, roots);
    const launcher = createFakeLauncher();

    const result = await runBench(runRequest(s, roots, {}, { launcher, github: createFakeBenchGithub({ repository: 'github.com/Bench-Owner/Bench-Repo' }) }));

    expect({ code: codeOf(result), launches: launcher.launches.length }).toEqual({ code: null, launches: 1 });
  });

  it('installs, in every run, the flow bytes it validated before the first, though the file changes between runs', async () => {
    fresh();
    const s = await capturedSetup(b, roots);
    const file = join(b.outsideDir('bench-flow-edit'), 'flow.yaml');
    writeFileSync(file, EDITED_V3_FLOW);
    const installed: (string | undefined)[] = [];
    const launcher = createFakeLauncher({
      scripts: [{}, {}],
      inspect: (launch) => {
        installed.push(installedFlow(launch.workingFolder, roots.appHome)?.flow);
        writeFileSync(file, `${V3_FLOW}# changed after validation\n`);
      },
    });

    await runBench(runRequest(s, roots, { flow: { kind: 'path', file }, runs: '2' }, { launcher }));

    expect(installed).toEqual([EDITED_V3_FLOW, EDITED_V3_FLOW]);
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
    {
      name: "a fixture commit that makes only the repo's flow catalog a link out of the tree",
      arrange: () => {
        const { dir } = b.makeRepository('bench-confine-d');
        const outsideDir = b.outsideDir('bench-confine-d-out');
        b.git(dir, ['checkout', '-q', '-b', 'hostile']);
        const commit = b.commitTrackedSymlink(dir, [FLOW_HOME_SUBDIR, FLOWS_CATALOG_SUBDIR].join('/'), outsideDir);
        b.git(dir, ['checkout', '-q', 'main']);
        b.seedFlow(dir, 'feature-dev-v3', V3_FLOW);
        const fixture = join(b.outsideDir('bench-confine-d-fx'), 'fx');
        b.writeHandFixture(fixture, handFields(commit), FIXTURE_ARTIFACTS);
        return { fixture, repo: dir, outside: () => readTree(outsideDir), outsideBefore: {} };
      },
    },
    {
      name: 'a fixture commit that makes a folder inside the loop artifacts a link out of the tree',
      arrange: () => {
        const { dir } = b.makeRepository('bench-confine-e');
        const outsideDir = b.outsideDir('bench-confine-e-out');
        b.git(dir, ['checkout', '-q', '-b', 'hostile']);
        const commit = b.commitTrackedSymlink(dir, [...APP_LOOP_DIR_SEGMENTS, ARTIFACTS_SUBDIR, 'impl-report'].join('/'), outsideDir);
        b.git(dir, ['checkout', '-q', 'main']);
        b.seedFlow(dir, 'feature-dev-v3', V3_FLOW);
        const fixture = join(b.outsideDir('bench-confine-e-fx'), 'fx');
        b.writeHandFixture(fixture, handFields(commit), FIXTURE_ARTIFACTS);
        return { fixture, repo: dir, outside: () => readTree(outsideDir), outsideBefore: {} };
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

  it.each(['../escaped', '..', 'a/b'])('fails on a clock stamp %j that is not one path segment, making no folder and launching nothing', async (stamp) => {
    fresh();
    const s = await capturedSetup(b, roots);
    const entries = (): string[] => readdirSync(roots.appHome, { recursive: true }).map(String).sort();
    const before = entries();
    const launcher = createFakeLauncher();
    const github = createFakeBenchGithub();

    const run = runBench(runRequest(s, roots, {}, { clock: createFakeBenchClock([stamp]), launcher, github }));

    await expect(run).rejects.toThrow();
    expect({ copies: copies(github.writes), launches: launcher.launches.length, home: entries() }).toEqual({ copies: [], launches: 0, home: before });
  });
});

/** The run record in `runFolder` as its reader reads it; null when there is none. */
function recordIn(runFolder: string): BenchRunRecord | { unparsable: string } | null {
  const file = join(runFolder, BENCH_RUN_RECORD_FILE);
  if (!existsSync(file)) return null;
  const read = parseBenchRunRecord(readFileSync(file, 'utf8'));
  return read.ok ? read.record : { unparsable: read.reason };
}

const recordedFlow = (runFolder: string | undefined): BenchRunRecord['flow'] | null => {
  const record = runFolder === undefined ? null : recordIn(runFolder);
  return record !== null && 'flow' in record ? record.flow : null;
};

const promptRevisionOf = (record: BenchRunRecord | { unparsable: string } | null): string | null => (record !== null && 'promptRevision' in record ? record.promptRevision : null);

describe('the run record', () => {
  it.each([
    { script: 'left span', ending: 'left span' },
    { script: 'completed', ending: 'completed' },
    { script: 'terminated', ending: 'terminated' },
    { script: 'window closed', ending: 'window closed' },
    { script: undefined, ending: 'app exited' },
    { script: 'unparsable', ending: 'app exited' },
  ] as const)('names the ending $ending for a span-end file $script, and the flow, revisions, fixture, span, issues, branch and the app\'s own wall-clock time', async ({ script, ending }) => {
    fresh();
    const s = await capturedSetup(b, roots);
    const clock = createFakeBenchClock(['s1']);
    // Preparation moves the clock too, by a different amount, so a time that counts it shows.
    const github = createFakeBenchGithub({ onCopy: () => clock.advance(7_000) });
    const launcher = createFakeLauncher({ clock, scripts: [{ ending: script, durationMs: 42_000 }] });

    const result = await runBench(runRequest(s, roots, {}, { github, launcher, clock }));

    const wf = launcher.launches[0]?.workingFolder ?? '';
    const { load } = readUntrustedFlowDefinition(V3_FLOW_FILE);
    if (!load.ok) throw new Error('setup: feature-dev-v3 does not load');
    expect(result.runFolders.map(recordIn)).toEqual([
      {
        schema_version: BENCH_RUN_RECORD_SCHEMA,
        flow: { id: 'feature-dev-v3', definitionRevision: flowDefinitionRevision(V3_FLOW) },
        promptRevision: promptRevision({ definition: load.definition, span: { first: 'red', last: 'refactor' }, appBundle: roots.bundle, userConfigRoot: roots.configDir, repoDir: wf }),
        fixture: s.fixture,
        span: { first: 'red', last: 'refactor' },
        fixtureIssue: { repository: FAKE_BENCH_REPOSITORY, number: 180 },
        issueCopy: { number: 501 },
        branch: b.git(wf, ['rev-parse', '--abbrev-ref', 'HEAD']),
        ending,
        wallClockMs: 42_000,
      },
    ]);
  });

  it("names the flow's id and one flow-definition revision whether the flow is named by catalog id or by the path it resolved to, and another revision for other bytes", async () => {
    fresh();
    const s = await capturedSetup(b, roots);
    const edited = join(b.outsideDir('bench-flow-revision'), 'flow.yaml');
    writeFileSync(edited, EDITED_V3_FLOW);
    const forms: [string, BenchFlowRef][] = [
      ['id', { kind: 'id', id: 'feature-dev-v3' }],
      ['path', { kind: 'path', file: catalogEntryDefFile(s.repo, 'feature-dev-v3') }],
      ['edited', { kind: 'path', file: edited }],
    ];
    const flows: Record<string, BenchRunRecord['flow'] | null> = {};
    for (const [name, flow] of forms) {
      const result = await runBench(runRequest(s, roots, { flow }, { clock: createFakeBenchClock([name]) }));
      flows[name] = recordedFlow(result.runFolders[0]);
    }

    expect({ flows, distinctRevisions: new Set(Object.values(flows).map((f) => f?.definitionRevision)).size }).toEqual({
      flows: {
        id: { id: 'feature-dev-v3', definitionRevision: flowDefinitionRevision(V3_FLOW) },
        path: { id: 'feature-dev-v3', definitionRevision: flowDefinitionRevision(V3_FLOW) },
        edited: { id: 'feature-dev-v3', definitionRevision: flowDefinitionRevision(EDITED_V3_FLOW) },
      },
      distinctRevisions: 2,
    });
  });

  it('gives two commands from one fixture equal prompt revisions with no edit between them and different ones after a charter edit, the flow-definition revision equal throughout', async () => {
    fresh();
    const s = await capturedSetup(b, roots);
    const command = async (stamp: string): Promise<BenchRunRecord | { unparsable: string } | null> => {
      const result = await runBench(runRequest(s, roots, {}, { clock: createFakeBenchClock([stamp]) }));
      return result.runFolders[0] === undefined ? null : recordIn(result.runFolders[0]);
    };
    const first = await command('first');
    const unedited = await command('unedited');
    appendFileSync(join(resolveExampleLoopsV2Dir(roots.bundle), 'feature-dev-v3', 'red-loop', 'charter', 'tests.md'), '\n<!-- edited -->\n');
    const edited = await command('edited');

    const records = [first, unedited, edited];
    expect({
      recorded: records.map((r) => promptRevisionOf(r) !== null),
      uneditedEqual: promptRevisionOf(unedited) === promptRevisionOf(first),
      editedEqual: promptRevisionOf(edited) === promptRevisionOf(unedited),
      definitionRevisions: new Set(records.map((r) => (r !== null && 'flow' in r ? r.flow.definitionRevision : null))).size,
    }).toEqual({ recorded: [true, true, true], uneditedEqual: true, editedEqual: false, definitionRevisions: 1 });
  });

  it("follows the operator-tier copy of a span loop the app resolves: an edit to it between two commands changes the prompt revision, an edit to the shadowed shipped copy does not", async () => {
    fresh();
    const s = await capturedSetup(b, roots);
    const shipped = join(resolveExampleLoopsV2Dir(roots.bundle), 'feature-dev-v3', 'red-loop');
    const operator = join(userConfigLoopsV2Dir(roots.configDir) ?? '', 'feature-dev-v3', 'red-loop');
    mkdirSync(dirname(operator), { recursive: true });
    cpSync(shipped, operator, { recursive: true });
    const command = async (stamp: string): Promise<BenchRunRecord | { unparsable: string } | null> => {
      const result = await runBench(runRequest(s, roots, {}, { clock: createFakeBenchClock([stamp]) }));
      return result.runFolders[0] === undefined ? null : recordIn(result.runFolders[0]);
    };
    const first = await command('first');
    appendFileSync(join(operator, 'charter', 'tests.md'), '\n<!-- edited -->\n');
    const operatorEdited = await command('operator-edited');
    appendFileSync(join(shipped, 'charter', 'tests.md'), '\n<!-- edited -->\n');
    const shadowedEdited = await command('shadowed-edited');

    const records = [first, operatorEdited, shadowedEdited];
    expect({
      recorded: records.map((r) => promptRevisionOf(r) !== null),
      operatorEditCounts: promptRevisionOf(operatorEdited) !== promptRevisionOf(first),
      shadowedEditIgnored: promptRevisionOf(shadowedEdited) === promptRevisionOf(operatorEdited),
      definitionRevisions: new Set(records.map((r) => (r !== null && 'flow' in r ? r.flow.definitionRevision : null))).size,
    }).toEqual({ recorded: [true, true, true], operatorEditCounts: true, shadowedEditIgnored: true, definitionRevisions: 1 });
  });

  it("resolves the repository tier in the run's working folder: an override of a span loop only in the invoking repository leaves the prompt revision equal", async () => {
    fresh();
    const s = await capturedSetup(b, roots);
    const command = async (stamp: string): Promise<BenchRunRecord | { unparsable: string } | null> => {
      const result = await runBench(runRequest(s, roots, {}, { clock: createFakeBenchClock([stamp]) }));
      return result.runFolders[0] === undefined ? null : recordIn(result.runFolders[0]);
    };
    const first = await command('first');
    const override = join(s.repo, 'loops', 'red-loop');
    cpSync(join(resolveExampleLoopsV2Dir(roots.bundle), 'feature-dev-v3', 'red-loop'), override, { recursive: true });
    appendFileSync(join(override, 'charter', 'tests.md'), '\n<!-- edited -->\n');
    writeFileSync(join(s.repo, '.agent-loop.yaml'), 'loops:\n  red-loop: loops/red-loop/red-loop.yaml\n');
    const invokingOverridden = await command('invoking-overridden');
    appendFileSync(join(resolveExampleLoopsV2Dir(roots.bundle), 'feature-dev-v3', 'red-loop', 'charter', 'tests.md'), '\n<!-- edited -->\n');
    const shippedEdited = await command('shipped-edited');

    expect({
      recorded: [first, invokingOverridden, shippedEdited].map((r) => promptRevisionOf(r) !== null),
      invokingOverrideIgnored: promptRevisionOf(invokingOverridden) === promptRevisionOf(first),
      shippedEditCounts: promptRevisionOf(shippedEdited) !== promptRevisionOf(invokingOverridden),
    }).toEqual({ recorded: [true, true, true], invokingOverrideIgnored: true, shippedEditCounts: true });
  });

  it("resolves the repository tier in the run's working folder: an override of a span loop the fixture commit carries is the copy the prompt revision covers", async () => {
    fresh();
    const s = await capturedSetup(b, roots, 'bench-run', (dir) => {
      const override = join(dir, 'loops', 'red-loop');
      cpSync(join(resolveExampleLoopsV2Dir(roots.bundle), 'feature-dev-v3', 'red-loop'), override, { recursive: true });
      appendFileSync(join(override, 'charter', 'tests.md'), '\n<!-- edited -->\n');
      writeFileSync(join(dir, '.agent-loop.yaml'), 'loops:\n  red-loop: loops/red-loop/red-loop.yaml\n');
      b.git(dir, ['add', '-A']);
      b.git(dir, ['commit', '-q', '-m', 'override red-loop']);
    });
    const launcher = createFakeLauncher();

    const result = await runBench(runRequest(s, roots, {}, { launcher }));

    const wf = launcher.launches[0]?.workingFolder ?? '';
    const { load } = readUntrustedFlowDefinition(V3_FLOW_FILE);
    if (!load.ok) throw new Error('setup: feature-dev-v3 does not load');
    const revisionIn = (repoDir: string): string =>
      promptRevision({ definition: load.definition, span: { first: 'red', last: 'refactor' }, appBundle: roots.bundle, userConfigRoot: roots.configDir, repoDir });
    const recorded = promptRevisionOf(result.runFolders[0] === undefined ? null : recordIn(result.runFolders[0]));
    expect({
      workingFolderCarriesOverride: existsSync(join(wf, '.agent-loop.yaml')),
      recordedIsWorkingFolders: recorded === revisionIn(wf),
      overrideCounts: revisionIn(wf) !== revisionIn(b.outsideDir('bench-run-no-repo-tier')),
    }).toEqual({ workingFolderCarriesOverride: true, recordedIsWorkingFolders: true, overrideCounts: true });
  });

  it("writes run k's record after its app exits and before run k+1 is prepared", async () => {
    fresh();
    const s = await capturedSetup(b, roots);
    const seen: string[] = [];
    // Run k's folder holds its working folder, so the launch names it however the runner reports folders.
    const recorded = (k: number): boolean => {
      const launch = launcher.launches[k - 1];
      if (launch === undefined) throw new Error(`run ${k} was not launched`);
      return existsSync(join(dirname(launch.workingFolder), BENCH_RUN_RECORD_FILE));
    };
    const github = createFakeBenchGithub({
      onCopy: () => {
        // Run k+1's issue is copied after app k opened and before app k+1 does.
        const k = launcher.launches.length;
        if (k > 0) seen.push(`copy ${k + 1}: record ${k} ${recorded(k)}`);
      },
    });
    const launcher = createFakeLauncher({ scripts: [{ holdMs: 50 }, { holdMs: 50 }], inspect: (_, k) => seen.push(`open ${k}: record ${k} ${recorded(k)}`) });

    await runBench(runRequest(s, roots, { runs: '2' }, { github, launcher }));

    expect({ seen, lastRecorded: recorded(2) }).toEqual({
      seen: ['open 1: record 1 false', 'copy 2: record 1 true', 'open 2: record 2 false'],
      lastRecorded: true,
    });
  });
});

describe("each run's own outputs", () => {
  it('leaves in each of three run folders its own record and only its own audit log; a run whose span ended before Start has no audit log and still a record', async () => {
    fresh();
    const s = await capturedSetup(b, roots);
    const auditRoot = auditRootDir(roots.appHome);
    const recorder = createAuditRecorder({ root: auditRoot, now: () => new Date('2026-10-20T12:00:00.000Z'), flowName: () => 'feature-dev-v3' });
    // Runs 1 and 2 are Started in their app, which opens their §25 audit log; run 3's app is closed before Start.
    const launcher = createFakeLauncher({
      scripts: [{}, {}, {}],
      inspect: (launch, k) => {
        if (k < 3) recorder.recordTransition(launch.workingFolder, 'start', { status: 'not_started', stepName: 'red' }, { status: 'in_progress', stepName: 'red' });
      },
    });

    const result = await runBench(runRequest(s, roots, { runs: '3' }, { launcher }));

    const ownLogs = launcher.launches.map((l) => readTree(auditRepoDir(auditRoot, l.workingFolder)));
    expect({
      ownLogFiles: ownLogs.map((log) => Object.keys(log).length),
      runs: result.runFolders.map((folder) => {
        const record = recordIn(folder);
        const parsed = record !== null && 'issueCopy' in record ? record : null;
        return { issueCopy: parsed?.issueCopy.number ?? null, branch: parsed?.branch ?? null, audit: readTree(join(folder, BENCH_RUN_AUDIT_DIR)) };
      }),
    }).toEqual({
      ownLogFiles: [1, 1, 0],
      runs: ownLogs.map((log, i) => ({
        issueCopy: FAKE_FIRST_COPY + i,
        branch: b.git(launcher.launches[i]?.workingFolder ?? '', ['rev-parse', '--abbrev-ref', 'HEAD']),
        audit: log,
      })),
    });
  });
});

describe("the fixture's phase baseline", () => {
  it("is what the app's baseline reader returns for the run's own branch, and nothing when the fixture has none", async () => {
    fresh();
    const s = await capturedSetup(b, roots);
    const withBaseline = join(b.outsideDir('bench-baseline'), 'fx');
    b.writeHandFixture(withBaseline, { ...handFields(s.commit), phase_baseline: s.commit }, FIXTURE_ARTIFACTS);
    const seen: Record<string, { branch: string | null; baseline: unknown }> = {};
    for (const [name, fixture] of [['with', withBaseline], ['without', s.fixture]] as const) {
      const launcher = createFakeLauncher({
        inspect: (launch) => {
          const read = currentGitBranch(launch.workingFolder);
          const branch = read.ok ? read.branch : null;
          seen[name] = { branch, baseline: baselineForBranch(readBaselineCommit(launch.workingFolder), branch) };
        },
      });
      await runBench(runRequest({ repo: s.repo, fixture }, roots, {}, { launcher, clock: createFakeBenchClock([name]) }));
    }

    expect({ with: seen.with?.baseline, without: seen.without?.baseline }).toEqual({ with: { branch: seen.with?.branch, sha: s.commit }, without: null });
  });
});
