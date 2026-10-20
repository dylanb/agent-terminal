import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { createBenchFixtureBuilder, type BenchFixtureBuilder } from '../helpers/benchFixtureBuilder';
import { createBenchRoots, type BenchRoots } from '../helpers/benchRoots';
import { createFakeBenchGithub, FAKE_BENCH_REPOSITORY } from '../helpers/benchFakeGithub';
import { captureFixture, type BenchCaptureResult } from '../../src/main/benchCapture';
import { BENCH_FIXTURE_ARTIFACTS, BENCH_FIXTURE_MANIFEST, parseBenchFixture, type BenchFixtureRead } from '../../src/shared/benchFixture';
import { createFlowStateStore } from '../../src/main/flowState';
import { recordBaselineCommit } from '../../src/main/appLoopState';
import { APP_LOOP_DIR_SEGMENTS, ARTIFACTS_SUBDIR } from '../../src/main/appLoopPaths';

// #180 AC 7 (capture half), AC 8 — `bench capture` over real git and the app's own state writers.

const V3_FLOW = readFileSync(join(process.cwd(), 'example', 'flows', 'feature-dev-v3', 'flow.yaml'), 'utf8');
// The ticket input renamed, so a capture that finds it must read the flow's declaration, not assume `ticket`.
const TICKET_INPUT = 'issue_ref';
const FLOW = V3_FLOW.replace('- name: ticket', `- name: ${TICKET_INPUT}`);
const ARTIFACTS: Record<string, Buffer> = {
  'groomed-ticket.md': Buffer.from('# groomed\n'),
  'plan.md': Buffer.from('# plan\n\nno trailing newline'),
  'impl-report/infra.md': Buffer.from('## infra\n'),
  'raw.bin': Buffer.from([0xff, 0x00, 0x0a, 0xfe]),
};

let b: BenchFixtureBuilder;
let roots: BenchRoots;
afterEach(() => {
  b?.cleanup();
  roots?.cleanup();
});

interface Folder {
  dir: string;
  base: string;
  head: string;
}

function artifactsDir(dir: string): string {
  return join(dir, ...APP_LOOP_DIR_SEGMENTS, ARTIFACTS_SUBDIR);
}

/** A run's working folder, captured after `infra`: two commits on `main`, the flow installed, its flow-state at
 *  `red` with the ticket, a slice count and slice 1's refactor count, and the artifacts written so far. */
function runFolder(inputs: Record<string, string> = { [TICKET_INPUT]: '180', slices: '2' }): Folder {
  b = createBenchFixtureBuilder();
  roots = createBenchRoots();
  const { dir, commit: base } = b.makeRepository('bench-capture');
  b.writeRepoFile(dir, 'src/a.ts', 'export const a = 1;\n');
  const head = b.commitAll(dir, 'second');
  b.seedFlow(dir, 'feature-dev-v3', FLOW);
  createFlowStateStore(dir).write({ step: 'red', status: 'not_started', inputs, repeatCounts: { refactor: 1 } });
  for (const [rel, bytes] of Object.entries(ARTIFACTS)) {
    const file = join(artifactsDir(dir), rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }
  return { dir, base, head };
}

function capture(dir: string, fixtureDir: string): Promise<BenchCaptureResult> {
  return captureFixture({ workingFolder: dir, fixtureDir, appHome: roots.appHome, github: createFakeBenchGithub() });
}

function fixtureRead(fixtureDir: string): BenchFixtureRead | null {
  const manifest = join(fixtureDir, BENCH_FIXTURE_MANIFEST);
  return existsSync(manifest) ? parseBenchFixture(readFileSync(manifest, 'utf8')) : null;
}

/** Every file under `root`, relative path → base64 bytes. */
function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const abs = join(entry.parentPath, entry.name);
    out[relative(root, abs)] = readFileSync(abs).toString('base64');
  }
  return out;
}

describe('bench capture (AC 7)', () => {
  it('writes a fixture holding the commit, the phase baseline for the branch, the issue, the inputs without the ticket, and the repeat counts', async () => {
    const { dir, base, head } = runFolder();
    recordBaselineCommit(dir, 'main', base);
    const fixtureDir = join(b.outsideDir('bench-fixtures'), 'after-infra');

    const result = await capture(dir, fixtureDir);

    expect({ result, read: fixtureRead(fixtureDir) }).toEqual({
      result: { ok: true },
      read: {
        ok: true,
        fixture: {
          schema_version: 1,
          commit: head,
          phase_baseline: base,
          issue: { repository: FAKE_BENCH_REPOSITORY, number: 180 },
          inputs: { slices: '2' },
          repeat_counts: { refactor: 1 },
        },
      },
    });
  });

  it('copies the artifacts, a subfolder included, byte for byte', async () => {
    const { dir } = runFolder();
    const fixtureDir = join(b.outsideDir('bench-fixtures'), 'after-infra');

    await capture(dir, fixtureDir);

    expect(tree(join(fixtureDir, BENCH_FIXTURE_ARTIFACTS))).toEqual(tree(artifactsDir(dir)));
  });

  it.each([
    ['no baseline is recorded', (_dir: string, _base: string): void => {}],
    ['the baseline is recorded for another branch', (dir: string, base: string): void => void recordBaselineCommit(dir, 'other', base)],
  ])('writes no phase baseline when %s', async (_case, seedBaseline) => {
    const { dir, base } = runFolder();
    seedBaseline(dir, base);
    const fixtureDir = join(b.outsideDir('bench-fixtures'), 'no-baseline');

    await capture(dir, fixtureDir);

    const read = fixtureRead(fixtureDir);
    expect({ written: read?.ok === true, hasBaseline: read?.ok === true && 'phase_baseline' in read.fixture }).toEqual({ written: true, hasBaseline: false });
  });
});

describe('bench capture refusals', () => {
  it('refuses an artifact that resolves outside the folder, and writes no fixture', async () => {
    const { dir } = runFolder();
    b.plantEscapeLink(join(artifactsDir(dir), 'leak.md'));
    const fixtureDir = join(b.outsideDir('bench-fixtures'), 'escape');

    const result = await capture(dir, fixtureDir);

    expect({ result, fixture: existsSync(fixtureDir) }).toEqual({ result: { ok: false, code: 'artifact-escapes' }, fixture: false });
  });

  it('refuses a fixture folder that already exists, and leaves it as found', async () => {
    const { dir } = runFolder();
    const fixtureDir = join(b.outsideDir('bench-fixtures'), 'taken');
    mkdirSync(fixtureDir);
    writeFileSync(join(fixtureDir, 'keep.txt'), 'mine\n');

    const result = await capture(dir, fixtureDir);

    expect({ result, contents: tree(fixtureDir) }).toEqual({
      result: { ok: false, code: 'fixture-exists' },
      contents: { 'keep.txt': Buffer.from('mine\n').toString('base64') },
    });
  });

  it.each([
    ['has no value', {}],
    ['is `#180`', { [TICKET_INPUT]: '#180' }],
    ['is `1e2`', { [TICKET_INPUT]: '1e2' }],
    ['is `0`', { [TICKET_INPUT]: '0' }],
    ['is an issue URL', { [TICKET_INPUT]: 'https://github.com/fake/repo/issues/180' }],
  ])('refuses a folder whose ticket input %s, and writes no fixture', async (_case, ticket: Record<string, string>) => {
    const { dir } = runFolder({ ...ticket, slices: '2' });
    const fixtureDir = join(b.outsideDir('bench-fixtures'), 'no-ticket');

    const result = await capture(dir, fixtureDir);

    expect({ result, fixture: existsSync(fixtureDir) }).toEqual({ result: { ok: false, code: 'ticket-unresolved' }, fixture: false });
  });
});

describe('bench capture over uncommitted changes (AC 8)', () => {
  it.each([
    ['a modified tracked file', (f: Folder): void => b.writeRepoFile(f.dir, 'README.md', '# changed\n')],
    ['a staged file', (f: Folder): void => {
      b.writeRepoFile(f.dir, 'staged.ts', 'export {};\n');
      b.git(f.dir, ['add', '--', 'staged.ts']);
    }],
    ['only an untracked file git does not ignore', (f: Folder): void => b.writeRepoFile(f.dir, 'notes.txt', 'draft\n')],
  ])('refuses %s with its code and writes no fixture', async (_case, dirty) => {
    const folder = runFolder();
    dirty(folder);
    const fixtureDir = join(b.outsideDir('bench-fixtures'), 'dirty');

    const result = await capture(folder.dir, fixtureDir);

    expect({ result, fixture: existsSync(fixtureDir) }).toEqual({ result: { ok: false, code: 'uncommitted-changes' }, fixture: false });
  });

  it.each([
    ['only an ignored file', (f: Folder): void => {
      b.writeRepoFile(f.dir, '.gitignore', '.agent-terminal/\n*.log\n');
      b.commitAll(f.dir, 'ignore logs');
      b.writeRepoFile(f.dir, 'build.log', 'noise\n');
    }],
    ['only changes under .agent-terminal/, in a repository that does not ignore it', (f: Folder): void => {
      b.writeRepoFile(f.dir, '.agent-terminal/tracked.md', 'v1\n');
      b.git(f.dir, ['add', '-f', '--', '.agent-terminal/tracked.md']);
      b.writeRepoFile(f.dir, '.gitignore', '');
      b.git(f.dir, ['add', '--', '.gitignore']);
      b.git(f.dir, ['commit', '-q', '-m', 'track .agent-terminal']);
      b.writeRepoFile(f.dir, '.agent-terminal/tracked.md', 'v2\n');
    }],
  ])('allows %s and writes the fixture', async (_case, change) => {
    const folder = runFolder();
    change(folder);
    const fixtureDir = join(b.outsideDir('bench-fixtures'), 'allowed');

    const result = await capture(folder.dir, fixtureDir);

    expect({ result, written: fixtureRead(fixtureDir)?.ok === true }).toEqual({ result: { ok: true }, written: true });
  });
});
