import { afterEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBenchFixtureBuilder, type BenchFixtureBuilder } from '../helpers/benchFixtureBuilder';
import { createBenchRoots, type BenchRoots } from '../helpers/benchRoots';
import { createFakeBenchGithub } from '../helpers/benchFakeGithub';
import { createFakeBenchClock, createFakeLauncher } from '../helpers/benchFakeLauncher';
import { FIXTURE_ARTIFACTS, handFields, runRequest, V2_FLOW, V3_FLOW, worktreeCount } from '../helpers/benchRunSetup';
import { runBench, type BenchRunRequest } from '../../src/main/benchRun';
import { BENCH_FIXTURE_MANIFEST } from '../../src/shared/benchFixture';
import { clearActiveFlow } from '../../src/main/activeFlowPointer';
import type { BenchSpan } from '../../src/shared/benchLaunch';

// #180 — every `bench run` refusal (AC 10): each returns its own code before the label is checked, any issue is
// copied, any working folder is created or any app opens; and the PR-acting gate refusal holds for exactly the
// four gates the ticket names (Outcome rule 6).

let b: BenchFixtureBuilder;
let roots: BenchRoots;
afterEach(() => {
  b?.cleanup();
  roots?.cleanup();
});

interface Invoking {
  repo: string;
  commit: string;
  /** A new hand-written fixture folder for `commit`, with `fields` over the valid ones. */
  fixture(fields?: Record<string, unknown>): string;
}

/** An invoking repository with both shipped feature-dev flows in its catalog and `active` the active one. */
function invoking(active: 'feature-dev-v3' | 'unset' = 'feature-dev-v3'): Invoking {
  b = createBenchFixtureBuilder();
  roots = createBenchRoots();
  const { dir, commit } = b.makeRepository('bench-refusals');
  b.seedFlow(dir, 'feature-dev-v2', V2_FLOW);
  b.seedFlow(dir, 'feature-dev-v3', V3_FLOW);
  if (active === 'unset') clearActiveFlow(dir);
  const fixtures = b.outsideDir('bench-refusals-fx');
  let n = 0;
  return {
    repo: dir,
    commit,
    fixture: (fields = {}) => {
      const fx = join(fixtures, `fx-${++n}`);
      b.writeHandFixture(fx, { ...handFields(commit), ...fields }, FIXTURE_ARTIFACTS);
      return fx;
    },
  };
}

/** What a refused command must leave: its code, and no GitHub write, app, run folder or worktree. */
async function refusalOf(inv: Invoking, over: Partial<Omit<BenchRunRequest, 'deps'>>): Promise<unknown> {
  const github = createFakeBenchGithub();
  const launcher = createFakeLauncher();
  const result = await runBench(runRequest({ repo: inv.repo, fixture: inv.fixture() }, roots, over, { github, launcher }));
  return { code: result.ok ? null : result.code, writes: github.writes, launches: launcher.launches.length, appHome: readdirSync(roots.appHome), worktrees: worktreeCount(b, inv.repo) };
}

const refusedWith = (code: string) => ({ code, writes: [], launches: 0, appHome: [], worktrees: 1 });

const span = (first: string, last = first): BenchSpan => ({ first, last });

describe('bench run refusals', () => {
  type Row = { name: string; code: string; over: (inv: Invoking) => Partial<Omit<BenchRunRequest, 'deps'>> };
  const rows: Row[] = [
    { name: 'a catalog id that names no flow', code: 'flow-unloadable', over: () => ({ flow: { kind: 'id', id: 'no-such-flow' } }) },
    { name: 'a path to no flow file', code: 'flow-unloadable', over: () => ({ flow: { kind: 'path', file: join(b.outsideDir('bench-noflow'), 'flow.yaml') } }) },
    {
      name: 'a path to a flow file that does not validate',
      code: 'flow-unloadable',
      over: () => {
        const file = join(b.outsideDir('bench-badflow'), 'flow.yaml');
        writeFileSync(file, 'name: broken\nsteps: [\n');
        return { flow: { kind: 'path', file } };
      },
    },
    {
      name: 'a flow one of whose loop steps names a loop no tier holds',
      code: 'flow-unloadable',
      over: () => {
        const file = join(b.outsideDir('bench-missing-loop'), 'flow.yaml');
        const unresolvable = V3_FLOW.replace('loop: groom-goal-loop', 'loop: no-such-loop');
        if (unresolvable === V3_FLOW) throw new Error('setup: feature-dev-v3 no longer names groom-goal-loop');
        writeFileSync(file, unresolvable);
        return { flow: { kind: 'path', file } };
      },
    },
    { name: 'a span step the flow lacks', code: 'span-unknown-step', over: () => ({ span: span('red', 'no-such-step') }) },
    { name: 'a span first step the flow lacks', code: 'span-unknown-step', over: () => ({ span: span('no-such-step', 'refactor') }) },
    { name: 'span steps out of flow order', code: 'span-out-of-order', over: () => ({ span: span('refactor', 'red') }) },
    { name: 'run count 0', code: 'runs-invalid', over: () => ({ runs: '0' }) },
    { name: 'run count -1', code: 'runs-invalid', over: () => ({ runs: '-1' }) },
    { name: 'run count 1.5', code: 'runs-invalid', over: () => ({ runs: '1.5' }) },
    { name: 'run count x', code: 'runs-invalid', over: () => ({ runs: 'x' }) },
    {
      name: 'a fixture manifest that is not JSON',
      code: 'fixture-unparsable',
      over: (inv) => {
        const fx = inv.fixture();
        writeFileSync(join(fx, BENCH_FIXTURE_MANIFEST), '{ "schema_version": 1, ');
        return { fixtureDir: fx };
      },
    },
    { name: 'a fixture commit that is not an object id', code: 'fixture-unparsable', over: (inv) => ({ fixtureDir: inv.fixture({ commit: 'main' }) }) },
    { name: 'a fixture manifest with an unknown key', code: 'fixture-unparsable', over: (inv) => ({ fixtureDir: inv.fixture({ bogus: true }) }) },
    { name: 'a fixture of an unknown schema_version', code: 'fixture-unparsable', over: (inv) => ({ fixtureDir: inv.fixture({ schema_version: 99 }) }) },
    { name: 'a fixture phase_baseline that is not an object id', code: 'fixture-unparsable', over: (inv) => ({ fixtureDir: inv.fixture({ phase_baseline: 'main' }) }) },
    {
      name: 'a fixture issue whose repository is not a selector',
      code: 'fixture-unparsable',
      over: (inv) => ({ fixtureDir: inv.fixture({ issue: { repository: 'not a selector', number: 180 } }) }),
    },
    { name: 'a fixture issue number 0', code: 'fixture-unparsable', over: (inv) => ({ fixtureDir: inv.fixture({ issue: { repository: 'github.com/bench-owner/bench-repo', number: 0 } }) }) },
    {
      name: "a fixture whose inputs hold the flow's ticket input",
      code: 'fixture-unparsable',
      over: (inv) => ({ fixtureDir: inv.fixture({ inputs: { slices: '2', ticket: '180' } }) }),
    },
    { name: 'a fixture input that is not a string', code: 'fixture-unparsable', over: (inv) => ({ fixtureDir: inv.fixture({ inputs: { slices: 2 } }) }) },
    { name: 'fixture inputs that are not an object', code: 'fixture-unparsable', over: (inv) => ({ fixtureDir: inv.fixture({ inputs: ['slices'] }) }) },
    { name: 'a fixture repeat count of 0', code: 'fixture-unparsable', over: (inv) => ({ fixtureDir: inv.fixture({ repeat_counts: { refactor: 0 } }) }) },
    { name: 'a fixture repeat count that is not a whole number', code: 'fixture-unparsable', over: (inv) => ({ fixtureDir: inv.fixture({ repeat_counts: { refactor: 1.5 } }) }) },
    {
      name: 'a fixture folder with no fixture.json',
      code: 'fixture-unparsable',
      over: (inv) => {
        const fx = inv.fixture();
        rmSync(join(fx, BENCH_FIXTURE_MANIFEST));
        return { fixtureDir: fx };
      },
    },
    {
      name: 'a fixture.json that is a link to a valid manifest',
      code: 'fixture-unparsable',
      over: (inv) => {
        const fx = inv.fixture();
        const real = join(b.outsideDir('bench-refusals-manifest'), BENCH_FIXTURE_MANIFEST);
        writeFileSync(real, readFileSync(join(fx, BENCH_FIXTURE_MANIFEST)));
        rmSync(join(fx, BENCH_FIXTURE_MANIFEST));
        symlinkSync(real, join(fx, BENCH_FIXTURE_MANIFEST));
        return { fixtureDir: fx };
      },
    },
    {
      name: 'a valid fixture.json padded past the size the reader reads',
      code: 'fixture-unparsable',
      over: (inv) => {
        const fx = inv.fixture();
        const manifest = join(fx, BENCH_FIXTURE_MANIFEST);
        writeFileSync(manifest, `${readFileSync(manifest, 'utf8')}${' '.repeat(1024 * 1024)}`);
        return { fixtureDir: fx };
      },
    },
    { name: 'a fixture commit the invoking repository lacks', code: 'commit-absent', over: (inv) => ({ fixtureDir: inv.fixture({ commit: 'd'.repeat(40) }) }) },
    { name: 'a fixture commit that names a tree, not a commit', code: 'commit-absent', over: (inv) => ({ fixtureDir: inv.fixture({ commit: b.git(inv.repo, ['rev-parse', 'HEAD^{tree}']) }) }) },
    {
      name: "a fixture issue in another repository than the invoking one's",
      code: 'issue-other-repository',
      over: (inv) => ({ fixtureDir: inv.fixture({ issue: { repository: 'github.com/other-owner/other-repo', number: 180 } }) }),
    },
    { name: 'v3 plan-approve..plan-approve', code: 'pr-acting-gate', over: () => ({ span: span('plan-approve') }) },
    { name: 'v3 infra..impl-approve', code: 'pr-acting-gate', over: () => ({ span: span('infra', 'impl-approve') }) },
  ];

  it.each(rows)('refuses $name with $code before any side effect', async ({ code, over }) => {
    const inv = invoking();
    expect(await refusalOf(inv, over(inv))).toEqual(refusedWith(code));
  });

  const v2Rows: { name: string; span: BenchSpan }[] = [
    { name: 'v2 plan-polish..plan-polish', span: span('plan-polish') },
    { name: 'v2 infra..integration-slice', span: span('infra', 'integration-slice') },
  ];
  const actives = ['feature-dev-v3', 'unset'] as const;

  it.each(actives.flatMap((active) => v2Rows.map((r) => ({ ...r, active }))))(
    'refuses $name as a PR-acting gate with the invoking repository\'s active flow $active',
    async ({ span: s, active }) => {
      const inv = invoking(active);
      expect(await refusalOf(inv, { flow: { kind: 'id', id: 'feature-dev-v2' }, span: s })).toEqual(refusedWith('pr-acting-gate'));
    },
  );
});

describe('the PR-acting gate refusal', () => {
  const afterPickup: Record<string, Record<string, boolean>> = {
    'feature-dev-v3': { 'plan-approve': true, infra: false, red: false, green: false, refactor: false, 'integration-slice': false, 'impl-approve': true, finalize: false },
    'feature-dev-v2': { 'plan-polish': true, infra: false, red: false, green: false, refactor: false, 'integration-slice': true, finalize: false },
  };

  it.each(Object.keys(afterPickup))('refuses the one-step span of exactly the PR-acting gates after %s\'s pickup step', async (flow) => {
    const inv = invoking();
    const clock = createFakeBenchClock();
    const refused: Record<string, boolean> = {};
    for (const step of Object.keys(afterPickup[flow])) {
      const result = await runBench(
        runRequest({ repo: inv.repo, fixture: inv.fixture() }, roots, { flow: { kind: 'id', id: flow }, span: span(step) }, { clock, launcher: createFakeLauncher() }),
      );
      refused[step] = !result.ok && result.code === 'pr-acting-gate';
    }
    expect(refused).toEqual(afterPickup[flow]);
  });

  it.each([
    { name: 'v3 plan..plan-approve, which includes pickup', span: span('plan', 'plan-approve') },
    { name: 'v3 red..refactor, after pickup with no PR-acting gate', span: span('red', 'refactor') },
  ])('prepares and launches $name', async ({ span: s }) => {
    const inv = invoking();
    const launcher = createFakeLauncher();

    const result = await runBench(runRequest({ repo: inv.repo, fixture: inv.fixture() }, roots, { span: s }, { launcher }));

    expect({ ok: result.ok, spans: launcher.launches.map((l) => l.span) }).toEqual({ ok: true, spans: [s] });
  });
});

