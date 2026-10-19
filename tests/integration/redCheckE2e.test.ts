import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRedCheckReport, type RedCheckReport } from '../../src/shared/redCheck';

// §28.5.2

const ROOT = join(__dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'red-check.mjs');
const E2E = 'tests/fixtures/red-check/e2e';
const SPEC = `${E2E}/sample.spec.ts`;
const RUN_PLAYWRIGHT = join(ROOT, E2E, 'run-playwright.mjs');
const RECORD = join(ROOT, E2E, 'record-selection.mjs');

function redCheck(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  const run = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: opts.cwd ?? ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...opts.env },
  });
  const parsed = parseRedCheckReport(run.stdout);
  return { run, report: parsed.ok ? parsed.report : null, reason: parsed.ok ? '' : `${parsed.reason}\n${run.stdout}\n${run.stderr}` };
}

describe('scripts/red-check.mjs on a Playwright spec (§28.5.2)', () => {
  let report: RedCheckReport | null = null;
  let mixed: RedCheckReport | null = null;
  beforeAll(() => {
    const env = { RED_CHECK_E2E_RUNNER: RUN_PLAYWRIGHT };
    report = redCheck([`${SPEC}:3`, `${SPEC}:7`, `${SPEC}:12`, `${SPEC}:16`, `${SPEC}:21`], { env }).report;
    mixed = redCheck(['--config', 'tests/fixtures/red-check/vitest.config.mjs', `${SPEC}:3`], { env }).report;
  }, 180_000);

  const test = (name: string) => report?.tests.find((t) => t.name === name);

  it('reports an expect() failure at the line of the failing check, with a repo-relative path', () => {
    expect(test('fails at its check')).toMatchObject({ file: SPEC, outcome: 'failed-assertion', failures: [{ line: 4 }] });
  });

  it('reports every failing soft assertion in a test', () => {
    expect(test('fails two soft checks')?.failures.map((f) => f.line)).toEqual([8, 9]);
  });

  it('reports a passing test as passed', () => {
    expect(test('passes')?.outcome).toBe('passed');
  });

  it('reports a test that threw a non-assertion error as errored', () => {
    expect(test('throws a TypeError')?.outcome).toBe('errored');
  });

  it('reports a test that ran out of time as errored', () => {
    expect(test('runs out of time')?.outcome).toBe('errored');
  });

  it('runs only the selected tests, never the whole spec file', () => {
    expect(report?.tests.filter((t) => t.file === SPEC).map((t) => t.name).sort()).toEqual(['fails at its check', 'fails two soft checks', 'passes', 'runs out of time', 'throws a TypeError']);
  });

  it('merges a vitest run and a Playwright run into one report when given both', () => {
    const files = new Set(mixed?.tests.map((t) => t.file));
    expect(files).toEqual(new Set(['tests/fixtures/red-check/sample.case.ts', 'tests/fixtures/red-check/broken.case.mjs', SPEC]));
  });

  it('leaves nothing behind in .agent-terminal', () => {
    const dir = join(ROOT, '.agent-terminal');
    expect(existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith('red-check-')) : []).toEqual([]);
  });
});

describe('scripts/red-check.mjs selecting the tests a RED changed in a spec (§28.5.2)', () => {
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  };
  const spec = (tests: string[]) => `import { expect, test } from '@playwright/test';\n\n${tests.join('\n\n')}\n`;
  const t = (name: string, body: string) => `test('${name}', () => {\n  ${body}\n});`;

  function seedRepo(): string {
    const repo = mkdtempSync(join(tmpdir(), 'red-check-select-'));
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'red@check.test');
    git(repo, 'config', 'user.name', 'red check');
    mkdirSync(join(repo, 'tests', 'e2e'), { recursive: true });
    writeFileSync(join(repo, 'tests/e2e/a.spec.ts'), spec([t('one', 'expect(1).toBe(1);'), t('two', 'expect(2).toBe(2);')]));
    writeFileSync(join(repo, 'tests/e2e/untouched.spec.ts'), spec([t('alone', 'expect(1).toBe(1);')]));
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    return repo;
  }

  function selection(repo: string, args: string[]) {
    const recordTo = join(repo, 'selection.txt');
    writeFileSync(recordTo, '');
    const r = redCheck(args, { cwd: repo, env: { RED_CHECK_E2E_RUNNER: RECORD, RECORD_SELECTION_TO: recordTo } });
    return { ...r, selected: readFileSync(recordTo, 'utf8').split('\n').filter((l) => l !== '') };
  }

  it('selects the test whose body changed and the test that was added, by declaration line', () => {
    const repo = seedRepo();
    try {
      // `one` keeps its declaration at line 3 and changes its check; `two` is untouched; `three` is new at line 11.
      writeFileSync(join(repo, 'tests/e2e/a.spec.ts'), spec([t('one', 'expect(1).toBe(3);'), t('two', 'expect(2).toBe(2);'), t('three', 'expect(3).toBe(4);')]));
      const r = selection(repo, ['tests/e2e/a.spec.ts']);
      expect(r.report, r.reason).not.toBeNull();
      expect(r.selected).toEqual(['tests/e2e/a.spec.ts:3', 'tests/e2e/a.spec.ts:11']);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('selects a whole spec file the RED added', () => {
    const repo = seedRepo();
    try {
      writeFileSync(join(repo, 'tests/e2e/new.spec.ts'), spec([t('fresh', 'expect(1).toBe(2);')]));
      expect(selection(repo, ['tests/e2e/new.spec.ts']).selected).toEqual(['tests/e2e/new.spec.ts']);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('runs nothing for a spec the RED did not change, and reports nothing for it', () => {
    const repo = seedRepo();
    try {
      const r = selection(repo, ['tests/e2e/untouched.spec.ts']);
      expect(r.selected).toEqual([]);
      expect(r.report?.tests).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('passes an explicit file:line selector through unchanged', () => {
    const repo = seedRepo();
    try {
      expect(selection(repo, ['tests/e2e/untouched.spec.ts:3']).selected).toEqual(['tests/e2e/untouched.spec.ts:3']);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('scripts/e2e-podman.sh and e2e/entrypoint.sh carry a red-check run (§28.5.2)', () => {
  function fakeBin(names: string[]): { dir: string; log: string } {
    const dir = mkdtempSync(join(tmpdir(), 'red-check-fakebin-'));
    const log = join(dir, 'calls.log');
    for (const n of names) {
      const file = join(dir, n);
      writeFileSync(file, `#!/usr/bin/env bash\nprintf '%s' "${n}" >> "${log}"; for a in "$@"; do printf ' [%s]' "$a" >> "${log}"; done; printf ' PLAYWRIGHT_JSON_OUTPUT_NAME=%s\\n' "$PLAYWRIGHT_JSON_OUTPUT_NAME" >> "${log}"\n`);
      chmodSync(file, 0o755);
    }
    return { dir, log };
  }

  it('runs the container without a TTY when stdin is not one, handing it the red-check I/O directory', () => {
    const bin = fakeBin(['podman']);
    try {
      const r = spawnSync('bash', ['scripts/e2e-podman.sh'], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: `${bin.dir}:${process.env.PATH}`, E2E_IO_DIR: '.agent-terminal/red-check-x' },
      });
      expect(r.status, r.stderr).toBe(0);
      const runLine = readFileSync(bin.log, 'utf8').split('\n').find((l) => l.startsWith('podman [run]')) ?? '';
      expect(runLine).not.toContain('[-it]');
      expect(runLine).toContain('[E2E_IO_DIR=.agent-terminal/red-check-x]');
    } finally {
      rmSync(bin.dir, { recursive: true, force: true });
    }
  });

  it.each([
    [{}, 'agent-terminal-e2e-node_modules'],
    [{ E2E_NODE_MODULES_VOLUME: 'agent-terminal-e2e-node_modules-mine' }, 'agent-terminal-e2e-node_modules-mine'],
  ])('mounts the node_modules cache volume the run names, so concurrent runs from two checkouts need not share one (%o)', (env, volume) => {
    const bin = fakeBin(['podman']);
    try {
      const r = spawnSync('bash', ['scripts/e2e-podman.sh'], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: `${bin.dir}:${process.env.PATH}`, ...env },
      });
      expect(r.status, r.stderr).toBe(0);
      const runLine = readFileSync(bin.log, 'utf8').split('\n').find((l) => l.startsWith('podman [run]')) ?? '';
      expect(runLine).toContain(`[${volume}:/work/node_modules]`);
    } finally {
      rmSync(bin.dir, { recursive: true, force: true });
    }
  });

  it('runs exactly the selected tests with a JSON report into the I/O directory', () => {
    const bin = fakeBin(['pnpm', 'Xvfb', 'sleep']);
    const io = mkdtempSync(join(tmpdir(), 'red-check-io-'));
    try {
      writeFileSync(join(io, 'select.txt'), 'tests/e2e/a.spec.ts:3\ntests/e2e/a.spec.ts:11\n');
      const r = spawnSync('bash', ['e2e/entrypoint.sh'], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin.dir}:${process.env.PATH}`, E2E_IO_DIR: io },
      });
      expect(r.status, r.stderr).toBe(0);
      const testLine = readFileSync(bin.log, 'utf8').split('\n').find((l) => l.startsWith('pnpm [exec] [playwright]')) ?? '';
      expect(testLine).toBe(`pnpm [exec] [playwright] [test] [--reporter=list,json] [tests/e2e/a.spec.ts:3] [tests/e2e/a.spec.ts:11] PLAYWRIGHT_JSON_OUTPUT_NAME=${io}/report.json`);
    } finally {
      rmSync(bin.dir, { recursive: true, force: true });
      rmSync(io, { recursive: true, force: true });
    }
  });

  it('still runs the whole suite with the list reporter and an optional -g filter when no red-check run is asked for', () => {
    const bin = fakeBin(['pnpm', 'Xvfb', 'sleep']);
    try {
      const r = spawnSync('bash', ['e2e/entrypoint.sh'], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin.dir}:${process.env.PATH}`, E2E_GREP: 'Terminate', E2E_IO_DIR: '' },
      });
      expect(r.status, r.stderr).toBe(0);
      const testLine = readFileSync(bin.log, 'utf8').split('\n').find((l) => l.startsWith('pnpm [exec] [playwright]')) ?? '';
      expect(testLine).toBe('pnpm [exec] [playwright] [test] [--reporter=list] [-g] [Terminate] PLAYWRIGHT_JSON_OUTPUT_NAME=');
    } finally {
      rmSync(bin.dir, { recursive: true, force: true });
    }
  });
});
