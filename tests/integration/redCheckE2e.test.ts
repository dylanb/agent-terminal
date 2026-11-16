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

  it('reports a spec that failed to load as errored', () => {
    const r = redCheck([`${E2E}/broken.spec.ts:5`], { env: { RED_CHECK_E2E_RUNNER: RUN_PLAYWRIGHT } });
    expect(r.report, r.reason).not.toBeNull();
    expect(r.report?.tests).toEqual([{ file: `${E2E}/broken.spec.ts`, name: 'the spec failed to load', outcome: 'errored', failures: [] }]);
  }, 180_000);

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

  function selection(repo: string, args: string[], env: Record<string, string> = {}) {
    const recordTo = join(repo, 'selection.txt');
    writeFileSync(recordTo, '');
    const r = redCheck(args, { cwd: repo, env: { RED_CHECK_E2E_RUNNER: RECORD, RECORD_SELECTION_TO: recordTo, ...env } });
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

  it('selects a test declared by a loop, not the test above it', () => {
    const repo = seedRepo();
    try {
      const looped = (check: string) => `for (const n of [1, 2]) test(\`looped \${n}\`, () => {\n  ${check}\n});`;
      writeFileSync(join(repo, 'tests/e2e/a.spec.ts'), spec([t('one', 'expect(1).toBe(1);'), looped('expect(n).toBe(n);')]));
      git(repo, 'commit', '-q', '-am', 'loop');
      writeFileSync(join(repo, 'tests/e2e/a.spec.ts'), spec([t('one', 'expect(1).toBe(1);'), looped('expect(n).toBe(0);')]));
      expect(selection(repo, ['tests/e2e/a.spec.ts']).selected).toEqual(['tests/e2e/a.spec.ts:7']);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('selects the test a RED only deleted a line from', () => {
    const repo = seedRepo();
    try {
      writeFileSync(join(repo, 'tests/e2e/a.spec.ts'), spec([t('one', 'expect(1).toBe(1);'), "test('two', () => {\n});"]));
      expect(selection(repo, ['tests/e2e/a.spec.ts']).selected).toEqual(['tests/e2e/a.spec.ts:7']);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('names a spec given as ./path or an absolute path repo-relative, in the selection and the report', () => {
    const repo = seedRepo();
    try {
      writeFileSync(join(repo, 'tests/e2e/a.spec.ts'), spec([t('one', 'expect(1).toBe(3);'), t('two', 'expect(2).toBe(2);')]));
      const r = selection(repo, ['./tests/e2e/a.spec.ts', join(repo, 'tests/e2e/untouched.spec.ts:3')]);
      expect(r.selected).toEqual(['tests/e2e/a.spec.ts:3', 'tests/e2e/untouched.spec.ts:3']);
      expect(r.report?.tests.map((x) => x.file)).toEqual(['tests/e2e/a.spec.ts', 'tests/e2e/untouched.spec.ts']);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('reports a selected spec the run returned no result for as errored, never as nothing', () => {
    const repo = seedRepo();
    try {
      writeFileSync(join(repo, 'tests/e2e/a.spec.ts'), spec([t('one', 'expect(1).toBe(3);'), t('two', 'expect(2).toBe(2);')]));
      expect(selection(repo, ['tests/e2e/a.spec.ts']).report?.tests.map((x) => [x.file, x.outcome])).toEqual([['tests/e2e/a.spec.ts', 'errored']]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('reports every selected spec as errored when the run wrote no report', () => {
    const repo = seedRepo();
    try {
      writeFileSync(join(repo, 'tests/e2e/a.spec.ts'), spec([t('one', 'expect(1).toBe(3);'), t('two', 'expect(2).toBe(2);')]));
      const r = selection(repo, ['tests/e2e/a.spec.ts', 'tests/e2e/untouched.spec.ts:3'], { RECORD_NO_REPORT: '1' });
      expect(r.report?.tests.map((x) => [x.file, x.outcome])).toEqual([
        ['tests/e2e/a.spec.ts', 'errored'],
        ['tests/e2e/untouched.spec.ts', 'errored'],
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('selects the whole spec when git cannot diff it, so a broken diff never drops the spec from the check', () => {
    const repo = mkdtempSync(join(tmpdir(), 'red-check-select-'));
    try {
      git(repo, 'init', '-q');
      mkdirSync(join(repo, 'tests', 'e2e'), { recursive: true });
      writeFileSync(join(repo, 'tests/e2e/a.spec.ts'), spec([t('one', 'expect(1).toBe(3);')]));
      git(repo, 'add', '.');
      expect(selection(repo, ['tests/e2e/a.spec.ts']).selected).toEqual(['tests/e2e/a.spec.ts']);
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

  const podmanVolume = (script: string, env: Record<string, string>): string => {
    const bin = fakeBin(['podman']);
    try {
      const r = spawnSync('bash', [script], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: `${bin.dir}:${process.env.PATH}`, E2E_NODE_MODULES_VOLUME: '', ...env },
      });
      expect(r.status, r.stderr).toBe(0);
      const runLine = readFileSync(bin.log, 'utf8').split('\n').find((l) => l.startsWith('podman [run]')) ?? '';
      return /\[([^\]]*):\/work\/node_modules\]/.exec(runLine)?.[1] ?? '';
    } finally {
      rmSync(bin.dir, { recursive: true, force: true });
    }
  };

  it('mounts a node_modules cache volume of its own per checkout, so a red check in one worktree never shares one with a run in another', () => {
    const other = mkdtempSync(join(tmpdir(), 'red-check-checkout-'));
    try {
      mkdirSync(join(other, 'scripts'));
      writeFileSync(join(other, 'scripts', 'e2e-podman.sh'), readFileSync(join(ROOT, 'scripts', 'e2e-podman.sh')));
      const here = podmanVolume(join(ROOT, 'scripts', 'e2e-podman.sh'), {});
      expect(here).toMatch(/^agent-terminal-e2e-node_modules-\S+$/);
      expect(podmanVolume(join(ROOT, 'scripts', 'e2e-podman.sh'), {})).toBe(here);
      expect(podmanVolume(join(other, 'scripts', 'e2e-podman.sh'), {})).not.toBe(here);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('mounts the node_modules cache volume E2E_NODE_MODULES_VOLUME names', () => {
    expect(podmanVolume(join(ROOT, 'scripts', 'e2e-podman.sh'), { E2E_NODE_MODULES_VOLUME: 'agent-terminal-e2e-node_modules-mine' })).toBe('agent-terminal-e2e-node_modules-mine');
  });

  it('runs exactly the selected tests once each, with no retries, and a JSON report into the I/O directory', () => {
    const bin = fakeBin(['pnpm', 'Xvfb', 'sleep', 'node']);
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
      expect(testLine).toBe(`pnpm [exec] [playwright] [test] [--retries=0] [--reporter=list,json] [tests/e2e/a.spec.ts:3] [tests/e2e/a.spec.ts:11] PLAYWRIGHT_JSON_OUTPUT_NAME=${io}/report.json`);
    } finally {
      rmSync(bin.dir, { recursive: true, force: true });
      rmSync(io, { recursive: true, force: true });
    }
  });

  it('still runs the whole suite with the list reporter and an optional -g filter when no red-check run is asked for', () => {
    const bin = fakeBin(['pnpm', 'Xvfb', 'sleep', 'node']);
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
