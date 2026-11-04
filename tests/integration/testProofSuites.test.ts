import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProofSuites } from '../../src/main/testProofPorts';
import { hermeticPath } from '../helpers/testProofGh';
import { FIXTURES, installSuiteStandIns, writeElectronPackage, type SuiteStandIns } from '../helpers/testProofSuites';

const ELECTRON = '38.7.1';
const SEEDED = { E2E_GREP: 'smoke', E2E_IO_DIR: '.agent-terminal/red-check-seeded' };
const VALUED = /^--(reporter|outputFile(\.json)?|retry|allowOnly)$/;
const INLINE = /^--(reporter|outputFile(\.json)?|retry|allowOnly)=./;

/** argv elements after `test` that are neither the reporter, output-file or retry flags nor their values. */
function unexpectedArgs(argv: readonly string[]): string[] {
  const rest: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--' || INLINE.test(arg)) continue;
    if (VALUED.test(arg)) i++;
    else rest.push(arg);
  }
  return rest;
}
const saved = { PATH: process.env.PATH, E2E_GREP: process.env.E2E_GREP, E2E_IO_DIR: process.env.E2E_IO_DIR };

let scratch: string;
let root: string;
let suites: SuiteStandIns;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'test-proof-suites-'));
  root = join(scratch, 'repo');
  const bin = join(scratch, 'bin');
  suites = installSuiteStandIns({ root, bin, stateDir: join(scratch, 'state') });
  writeElectronPackage(root, ELECTRON);
  process.env.PATH = `${bin}:${hermeticPath(join(scratch, 'tools'), ['node'])}`;
  Object.assign(process.env, SEEDED);
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

const runOf = (suite: 'vitest' | 'e2e') => suites.read().runs.filter((r) => r.suite === suite);

describe('the proof suites adapter runs each suite and reads its result', () => {
  it('returns a passing vitest run with its counts and the host Node and installed Electron', async () => {
    const run = await createProofSuites(root).run('vitest');
    expect(run).toEqual({
      kind: 'ran',
      exitCode: 0,
      result: expect.objectContaining({ passed: 6, failed: 0, skipped: 4, flaky: 0, environment: { node: process.version, electron: ELECTRON } }),
    });
  });

  it('returns a failing vitest run with its exit code and failed count', async () => {
    suites.set({ vitest: { exitCode: 1, report: join(FIXTURES, 'vitest-fail.json') } });
    const run = await createProofSuites(root).run('vitest');
    expect.soft(run.kind === 'no-exit' ? undefined : run.exitCode).toBe(1);
    expect.soft(run.kind === 'ran' ? run.result.failed : undefined).toBe(1);
  });

  it('returns a passing e2e run with its counts and the environment the harness recorded', async () => {
    const run = await createProofSuites(root).run('e2e');
    expect(run).toEqual({
      kind: 'ran',
      exitCode: 0,
      result: expect.objectContaining({
        passed: 7,
        failed: 0,
        skipped: 3,
        flaky: 2,
        environment: { node: 'v22.11.0', electron: '39.2.4', image: 'sha256:5d1f0c7e9a3b2468ace0f13579bdf02468ace13579bdf02468ace13579bdf0' },
      }),
    });
  });

  it('returns a failing e2e run with its exit code and failed count', async () => {
    suites.set({ e2e: { exitCode: 3, report: join(FIXTURES, 'playwright-fail.json'), environment: join(FIXTURES, 'environment.json') } });
    const run = await createProofSuites(root).run('e2e');
    expect.soft(run.kind === 'no-exit' ? undefined : run.exitCode).toBe(3);
    expect.soft(run.kind === 'ran' ? run.result.failed : undefined).toBe(1);
  });

  it('reads an e2e run whose harness wrote no environment file as unreadable', async () => {
    suites.set({ e2e: { exitCode: 0, report: join(FIXTURES, 'playwright-pass.json'), environment: null } });
    expect((await createProofSuites(root).run('e2e')).kind).toBe('unreadable');
  });
});

describe('the proof suites adapter never reads a report left over from an earlier run', () => {
  it('reads vitest as unreadable when it exits 0 without writing a new report', async () => {
    await createProofSuites(root).run('vitest');
    suites.set({ vitest: { exitCode: 0, report: null } });
    expect((await createProofSuites(root).run('vitest')).kind).toBe('unreadable');
  });

  it('reads e2e as unreadable when it writes a new report but no new environment file', async () => {
    await createProofSuites(root).run('e2e');
    suites.set({ e2e: { exitCode: 0, report: join(FIXTURES, 'playwright-pass.json'), environment: null } });
    expect((await createProofSuites(root).run('e2e')).kind).toBe('unreadable');
  });

  it('reads e2e as unreadable when it exits 0 without writing a new report', async () => {
    await createProofSuites(root).run('e2e');
    suites.set({ e2e: { exitCode: 0, report: null, environment: null } });
    expect((await createProofSuites(root).run('e2e')).kind).toBe('unreadable');
  });
});

describe('the proof suites adapter runs both suites unnarrowed', () => {
  it('runs vitest as pnpm test in the repository, with retries off and no filter, whatever the environment holds', async () => {
    await createProofSuites(root).run('vitest');
    const [run] = runOf('vitest');
    expect.soft(runOf('vitest')).toHaveLength(1);
    expect.soft(run?.cwd).toBe(suites.root);
    const argv = run?.argv ?? [];
    expect.soft(argv[0]).toBe('test');
    expect.soft(unexpectedArgs(argv), JSON.stringify(argv)).toEqual([]);
    expect.soft(argv.some((a, i) => a === '--retry=0' || (a === '--retry' && argv[i + 1] === '0')), JSON.stringify(argv)).toBe(true);
    expect.soft(argv.some((a, i) => a === '--allowOnly=false' || (a === '--allowOnly' && argv[i + 1] === 'false')), 'a focused test fails the run').toBe(true);
  });

  it('runs the e2e harness with no argument and an empty E2E_IO_DIR, whatever the environment holds', async () => {
    await createProofSuites(root).run('e2e');
    const [run] = runOf('e2e');
    expect.soft(runOf('e2e')).toHaveLength(1);
    expect.soft(run?.argv).toEqual([]);
    expect.soft([null, ''], 'E2E_IO_DIR is unset or empty').toContain(run?.env.E2E_IO_DIR);
  });
});

describe('the proof suites adapter never follows a link out of the repository', () => {
  it('refuses a report dir reached through a link out of the repository, creating and running nothing there', async () => {
    const outside = join(scratch, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(root, '.agent-terminal'));
    const run = await createProofSuites(root).run('vitest');
    expect.soft(run.kind).toBe('no-exit');
    expect.soft(runOf('vitest')).toHaveLength(0);
    expect.soft(existsSync(join(outside, 'test-proof'))).toBe(false);
  });

  it('refuses an earlier report that is a link to a file outside the repository, leaving that file alone', async () => {
    await createProofSuites(root).run('vitest');
    const outside = join(scratch, 'outside-vitest.json');
    copyFileSync(join(FIXTURES, 'vitest-pass.json'), outside);
    const dir = join(root, '.agent-terminal', 'test-proof');
    rmSync(join(dir, 'vitest.json'), { force: true });
    symlinkSync(outside, join(dir, 'vitest.json'));
    const run = await createProofSuites(root).run('vitest');
    expect.soft(run.kind).toBe('no-exit');
    expect.soft(existsSync(outside)).toBe(true);
  });
});

describe('the proof suites adapter refuses a suite that did not run to its own exit', () => {
  it('reads a suite whose command cannot start as never reaching its exit, naming the command', async () => {
    process.env.PATH = hermeticPath(join(scratch, 'bare'), ['node']);
    const run = await createProofSuites(root).run('vitest');
    expect.soft(run.kind).toBe('no-exit');
    expect.soft(run.kind === 'no-exit' ? run.reason : '').toMatch(/pnpm/);
  });

  it('reads a suite killed by a signal after writing passing reports as never reaching its exit, naming the signal', async () => {
    writeFileSync(
      join(root, 'scripts', 'e2e-podman.sh'),
      `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dir = path.resolve(__dirname, '..', process.env.E2E_REPORT_DIR);
fs.copyFileSync(${JSON.stringify(join(FIXTURES, 'playwright-pass.json'))}, path.join(dir, 'report.json'));
fs.copyFileSync(${JSON.stringify(join(FIXTURES, 'environment.json'))}, path.join(dir, 'environment.json'));
process.kill(process.pid, 'SIGKILL');
`,
      { mode: 0o755 },
    );
    const run = await createProofSuites(root).run('e2e');
    expect.soft(run.kind).toBe('no-exit');
    expect.soft(run.kind === 'no-exit' ? run.reason : '').toMatch(/SIGKILL/);
  });
});

describe('the proof suites adapter refuses a vitest run whose Electron version cannot be read', () => {
  it.each([
    ['is missing', () => rmSync(join(root, 'node_modules', 'electron', 'package.json'))],
    ['has no version', () => writeFileSync(join(root, 'node_modules', 'electron', 'package.json'), JSON.stringify({ name: 'electron' }))],
  ])('reads vitest as unreadable when the installed Electron package.json %s', async (_what, breakIt) => {
    breakIt();
    const run = await createProofSuites(root).run('vitest');
    expect.soft(run.kind).toBe('unreadable');
    expect.soft(run.kind === 'unreadable' ? run.reason : '').toMatch(/electron/i);
  });
});
