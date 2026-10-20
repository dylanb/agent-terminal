import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createBenchFixtureBuilder, type BenchFixtureBuilder } from '../helpers/benchFixtureBuilder';
import { createBenchRoots, type BenchRoots } from '../helpers/benchRoots';
import { createFakeBenchGithub } from '../helpers/benchFakeGithub';
import { benchMain } from '../../src/main/benchMain';
import { BENCH_FIXTURE_MANIFEST } from '../../src/shared/benchFixture';
import { createFlowStateStore } from '../../src/main/flowState';

// #180 — the runner's pure entry: `capture`'s relative paths resolve against the invoking directory, which is
// `INIT_CWD` when `pnpm run` set it and the process's cwd otherwise.

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

const deps = () => ({ github: createFakeBenchGithub() });
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
