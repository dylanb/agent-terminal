import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createBenchFixtureBuilder, type BenchFixtureBuilder } from '../helpers/benchFixtureBuilder';
import { createBenchRoots, type BenchRoots } from '../helpers/benchRoots';
import { createFakeBenchGithub } from '../helpers/benchFakeGithub';
import { createFakeBenchClock, createFakeLauncher, type FakeLaunchScript } from '../helpers/benchFakeLauncher';
import { capturedSetup, V3_FLOW_FILE } from '../helpers/benchRunSetup';
import type { BenchDeps } from '../../src/main/benchMain';
import { benchMain } from '../../src/main/benchMain';
import { BENCH_FIXTURE_MANIFEST } from '../../src/shared/benchFixture';
import { createFlowStateStore } from '../../src/main/flowState';
import { resolveExampleLoopsV2Dir } from '../../src/main/exampleAssets';

// #180 — the runner's pure entry: `capture`'s relative paths resolve against the invoking directory, which is
// `INIT_CWD` when `pnpm run` set it and the process's cwd otherwise; `run` prints each run's folder, or the code
// of the refusal that stopped it.

const V3_FLOW = readFileSync(join(process.cwd(), 'example', 'flows', 'feature-dev-v3', 'flow.yaml'), 'utf8');

let b: BenchFixtureBuilder;
let roots: BenchRoots;
afterEach(() => {
  b?.cleanup();
  roots?.cleanup();
});

function runFolder(): string {
  b = createBenchFixtureBuilder();
  roots = createBenchRoots();
  const { dir } = b.makeRepository('bench-main');
  b.seedFlow(dir, 'feature-dev-v3', V3_FLOW);
  createFlowStateStore(dir).write({ step: 'plan', status: 'not_started', inputs: { ticket: '180' } });
  b.writeArtifacts(dir, { 'groomed-ticket.md': '# groomed\n' });
  return dir;
}

const deps = (scripts: FakeLaunchScript[] = [{}]): BenchDeps => ({
  github: createFakeBenchGithub(),
  launcher: createFakeLauncher({ scripts }),
  appBundle: roots.bundle,
  clock: createFakeBenchClock(),
});
const manifestIn = (dir: string): boolean => existsSync(join(dir, 'fx', BENCH_FIXTURE_MANIFEST));

describe('bench capture through the entry', () => {
  it('resolves relative paths against INIT_CWD when it is set, not against cwd', async () => {
    const wf = runFolder();
    const invoking = b.outsideDir('bench-invoking');
    // Deeper than `invoking`, so the relative working-folder argument names nothing from here.
    const elsewhere = join(b.outsideDir('bench-cwd'), 'a', 'b');
    mkdirSync(elsewhere, { recursive: true });

    const { exitCode } = await benchMain(['capture', relative(invoking, wf), 'fx'], roots.env({ INIT_CWD: invoking }), elsewhere, deps());

    expect({ exitCode, atInitCwd: manifestIn(invoking), atCwd: manifestIn(elsewhere) }).toEqual({ exitCode: 0, atInitCwd: true, atCwd: false });
  });

  it('resolves relative paths against cwd when INIT_CWD is not set', async () => {
    const wf = runFolder();
    const invoking = b.outsideDir('bench-invoking');

    const { exitCode } = await benchMain(['capture', relative(invoking, wf), 'fx'], roots.env(), invoking, deps());

    expect({ exitCode, atCwd: manifestIn(invoking) }).toEqual({ exitCode: 0, atCwd: true });
  });

  it('exits non-zero and prints the refusal\'s code when capture is refused, writing no fixture', async () => {
    const wf = runFolder();
    b.writeRepoFile(wf, 'notes.txt', 'draft\n');
    const invoking = b.outsideDir('bench-invoking');

    const { exitCode, output } = await benchMain(['capture', wf, 'fx'], roots.env(), invoking, deps());

    expect({ failed: exitCode !== 0, namesCode: output.includes('uncommitted-changes'), fixture: existsSync(join(invoking, 'fx')) }).toEqual({
      failed: true,
      namesCode: true,
      fixture: false,
    });
  });
});

describe('bench run through the entry', () => {
  const isInside = (parent: string, child: string): boolean => {
    const rel = relative(parent, child);
    return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep);
  };

  it.each([1, 3])('with --runs %i exits 0 and prints each run folder, each under the app home and outside the invoking repository', async (n) => {
    b = createBenchFixtureBuilder();
    roots = createBenchRoots();
    const s = await capturedSetup(b, roots);
    const argv = ['run', '--flow', 'feature-dev-v3', '--span', 'plan', '--fixture', relative(s.repo, s.fixture), '--runs', String(n)];
    const launcher = createFakeLauncher({ scripts: Array.from({ length: n }, () => ({})) });

    const { exitCode, output } = await benchMain(argv, roots.env({ INIT_CWD: s.repo }), s.repo, { ...deps(), launcher });

    const realHome = realpathSync(roots.appHome);
    const folders = output.split('\n').filter((l) => l.length > 0);
    expect({
      exitCode,
      folders: folders.map((f) => ({ folder: existsSync(f) && statSync(f).isDirectory(), underHome: existsSync(f) && isInside(realHome, realpathSync(f)), outsideRepo: !isInside(s.repo, f) })),
      distinct: new Set(folders).size,
      spans: launcher.launches.map((l) => l.span),
    }).toEqual({
      exitCode: 0,
      folders: Array.from({ length: n }, () => ({ folder: true, underHome: true, outsideRepo: true })),
      distinct: n,
      spans: Array.from({ length: n }, () => ({ first: 'plan', last: 'plan' })),
    });
  });

  it('reads flow and fixture paths relative to INIT_CWD and a first..last span range', async () => {
    b = createBenchFixtureBuilder();
    roots = createBenchRoots();
    const s = await capturedSetup(b, roots);
    const elsewhere = join(b.outsideDir('bench-cwd'), 'a', 'b');
    mkdirSync(elsewhere, { recursive: true });
    const launcher = createFakeLauncher();
    const argv = ['run', '--flow', relative(s.repo, V3_FLOW_FILE), '--span', 'red..refactor', '--fixture', relative(s.repo, s.fixture), '--runs', '1'];

    const { exitCode, output } = await benchMain(argv, roots.env({ INIT_CWD: s.repo }), elsewhere, { ...deps(), launcher });

    expect({ exitCode, spans: launcher.launches.map((l) => l.span), output }).toEqual({ exitCode: 0, spans: [{ first: 'red', last: 'refactor' }], output: expect.any(String) });
  });

  it.each([
    ['no --flow', (fx: string) => ['run', '--span', 'plan', '--fixture', fx, '--runs', '1']],
    ['no --span', (fx: string) => ['run', '--flow', 'feature-dev-v3', '--fixture', fx, '--runs', '1']],
    ['no --fixture', () => ['run', '--flow', 'feature-dev-v3', '--span', 'plan', '--runs', '1']],
    ['no --runs', (fx: string) => ['run', '--flow', 'feature-dev-v3', '--span', 'plan', '--fixture', fx]],
    ['--runs with no value', (fx: string) => ['run', '--flow', 'feature-dev-v3', '--span', 'plan', '--fixture', fx, '--runs']],
    ['an unknown flag', (fx: string) => ['run', '--flow', 'feature-dev-v3', '--span', 'plan', '--fixture', fx, '--runs', '1', '--bogus', 'x']],
    ['a stray positional', (fx: string) => ['run', 'extra', '--flow', 'feature-dev-v3', '--span', 'plan', '--fixture', fx, '--runs', '1']],
  ] as const)('prints the usage and exits non-zero for run with %s, before preparing or launching anything', async (_, argvOf) => {
    b = createBenchFixtureBuilder();
    roots = createBenchRoots();
    const s = await capturedSetup(b, roots);
    const github = createFakeBenchGithub();
    const launcher = createFakeLauncher();

    const { exitCode, output } = await benchMain(argvOf(s.fixture), roots.env({ INIT_CWD: s.repo }), s.repo, { ...deps(), github, launcher });

    expect({ failed: exitCode !== 0, usage: output.startsWith('usage:'), appHome: readdirSync(roots.appHome), writes: github.writes, launches: launcher.launches.length }).toEqual({
      failed: true,
      usage: true,
      appHome: [],
      writes: [],
      launches: 0,
    });
  });

  it.each([
    ['holds an operator-tier plan-approve-loop without mark-ready', true],
    ['holds no operator-tier override', false],
  ] as const)("reads loop defs from the env's CLAUDE_CONFIG_DIR: when it %s, span plan-approve is launched only then", async (_, override) => {
    b = createBenchFixtureBuilder();
    roots = createBenchRoots();
    const s = await capturedSetup(b, roots);
    const configDir = b.outsideDir('bench-env-claude-config');
    if (override) {
      const loop = join(configDir, 'loops-v2', 'feature-dev-v3', 'plan-approve-loop');
      cpSync(join(resolveExampleLoopsV2Dir(roots.bundle), 'feature-dev-v3', 'plan-approve-loop'), loop, { recursive: true });
      const def = join(loop, 'plan-approve-loop.yaml');
      const shipped = readFileSync(def, 'utf8');
      const unpublished = shipped.replace('      - kind: gh\n        action: mark-ready\n', '');
      if (unpublished === shipped) throw new Error('setup: the shipped plan-approve-loop no longer names mark-ready');
      writeFileSync(def, unpublished);
    }
    const launcher = createFakeLauncher();
    const argv = ['run', '--flow', 'feature-dev-v3', '--span', 'plan-approve', '--fixture', s.fixture, '--runs', '1'];

    const { exitCode, output } = await benchMain(argv, roots.env({ INIT_CWD: s.repo, CLAUDE_CONFIG_DIR: configDir }), s.repo, { ...deps(), launcher });

    expect({ exitCode: exitCode === 0 ? 0 : 'non-zero', refused: output.includes('pr-acting-gate'), spans: launcher.launches.map((l) => l.span) }).toEqual(
      override
        ? { exitCode: 0, refused: false, spans: [{ first: 'plan-approve', last: 'plan-approve' }] }
        : { exitCode: 'non-zero', refused: true, spans: [] },
    );
  });

  it("exits non-zero and prints the refusal's code when run is refused, creating no run folder", async () => {
    b = createBenchFixtureBuilder();
    roots = createBenchRoots();
    const s = await capturedSetup(b, roots);
    const argv = ['run', '--flow', 'feature-dev-v3', '--span', 'plan', '--fixture', s.fixture, '--runs', '0'];

    const { exitCode, output } = await benchMain(argv, roots.env({ INIT_CWD: s.repo }), s.repo, deps());

    expect({ failed: exitCode !== 0, namesCode: output.includes('runs-invalid'), appHome: readdirSync(roots.appHome), output }).toEqual({
      failed: true,
      namesCode: true,
      appHome: [],
      output: expect.any(String),
    });
  });
});
