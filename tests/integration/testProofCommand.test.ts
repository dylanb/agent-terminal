import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitRepoFixture, type GitRepoFixture } from '../helpers/gitRepo';
import { hermeticPath, installTestProofGh } from '../helpers/testProofGh';
import { FIXTURES, makeProofRepo } from '../helpers/testProofSuites';

const ROOT = join(__dirname, '..', '..');
const COMMAND_TIMEOUT_MS = 120_000;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('pnpm run test:proof', () => {
  it(
    'refuses an argument, naming it as the cause',
    () => {
      const bin = mkdtempSync(join(tmpdir(), 'test-proof-arg-gh-'));
      try {
        installTestProofGh(bin, { loggedIn: false });
        const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
        const run = spawnSync('pnpm', ['run', 'test:proof', 'unexpected-arg'], { cwd: ROOT, encoding: 'utf8', env });
        expect.soft(run.status).not.toBe(0);
        expect.soft(run.stderr).toContain('unexpected-arg');
      } finally {
        rmSync(bin, { recursive: true, force: true });
      }
    },
    COMMAND_TIMEOUT_MS,
  );

  it(
    'reports a failing step as one line and a non-zero exit, not a stack trace, outside a git repository',
    () => {
      const build = spawnSync('pnpm', ['exec', 'vite', 'build', '--config', 'vite.testProof.config.ts', '--logLevel', 'error'], { cwd: ROOT, encoding: 'utf8' });
      expect(build.status, build.stderr).toBe(0);
      const outside = mkdtempSync(join(tmpdir(), 'test-proof-no-repo-'));
      try {
        const run = spawnSync(process.execPath, [join(ROOT, 'out', 'test-proof', 'testProof.cjs')], { cwd: outside, encoding: 'utf8' });
        expect.soft(run.status).not.toBe(0);
        expect.soft(run.stderr).toMatch(/git/);
        expect.soft(run.stderr).not.toMatch(/^\s+at /m);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    },
    COMMAND_TIMEOUT_MS,
  );
});

describe('the built test:proof entry', () => {
  const bundle = join(ROOT, 'out', 'test-proof', 'testProof.cjs');
  let git: GitRepoFixture;
  let scratch: string;
  const spawned: ChildProcess[] = [];
  const suitePids: number[] = [];

  beforeAll(() => {
    const build = spawnSync('pnpm', ['exec', 'vite', 'build', '--config', 'vite.testProof.config.ts', '--logLevel', 'error'], { cwd: ROOT, encoding: 'utf8' });
    expect(build.status, build.stderr).toBe(0);
  }, COMMAND_TIMEOUT_MS);

  beforeEach(() => {
    git = createGitRepoFixture();
    scratch = mkdtempSync(join(tmpdir(), 'test-proof-entry-'));
  });

  afterEach(() => {
    for (const pid of suitePids.splice(0)) if (isAlive(pid)) process.kill(pid, 'SIGKILL');
    for (const child of spawned.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(scratch, { recursive: true, force: true });
    git.cleanup();
  });

  it(
    'proves a fixture repo end to end: both literal-context statuses on HEAD and one summary comment',
    () => {
      const bin = join(scratch, 'bin');
      const repo = makeProofRepo(git, { bin, stateDir: join(scratch, 'state'), branch: 'feature/proof', electronVersion: '38.7.1' });
      const gh = installTestProofGh(bin, { pullRequests: [{ number: 7, headRefName: repo.branch, headRefOid: repo.head, isCrossRepository: false }] });
      const PATH = `${bin}:${hermeticPath(join(scratch, 'tools'), ['node', 'git'])}`;
      const run = spawnSync(process.execPath, [bundle], { cwd: repo.dir, encoding: 'utf8', env: { ...process.env, PATH } });
      expect.soft(run.status, run.stderr).toBe(0);
      const state = gh.read();
      expect.soft(state.statuses.map((s) => `${s.context} ${s.state} ${s.sha}`).sort()).toEqual([
        `test-proof/e2e success ${repo.head}`,
        `test-proof/vitest success ${repo.head}`,
      ]);
      expect.soft(state.comments['7'] ?? []).toHaveLength(1);
    },
    COMMAND_TIMEOUT_MS,
  );

  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)(
    'refuses, publishing nothing, when the entry alone is sent %s, and a suite that stops only on SIGTERM does not outlive it',
    async (sent) => {
      const bin = join(scratch, 'bin');
      const repo = makeProofRepo(git, { bin, stateDir: join(scratch, 'state'), branch: 'feature/proof', electronVersion: '38.7.1' });
      const gh = installTestProofGh(bin, { pullRequests: [{ number: 7, headRefName: repo.branch, headRefOid: repo.head, isCrossRepository: false }] });
      const pidFile = join(scratch, 'suite.pid');
      const ignoredFile = join(scratch, 'suite.ignored');
      writeFileSync(
        join(bin, 'pnpm'),
        `#!/usr/bin/env node
const fs = require('node:fs');
const out = process.argv.find((a) => a.startsWith('--outputFile.json='));
process.on('SIGTERM', () => {
  fs.copyFileSync(${JSON.stringify(join(FIXTURES, 'vitest-pass.json'))}, out.slice(out.indexOf('=') + 1));
  process.exit(0);
});
for (const ignored of ['SIGINT', 'SIGHUP']) process.on(ignored, () => fs.writeFileSync(${JSON.stringify(ignoredFile)}, ignored));
fs.writeFileSync(${JSON.stringify(`${pidFile}.tmp`)}, String(process.pid));
fs.renameSync(${JSON.stringify(`${pidFile}.tmp`)}, ${JSON.stringify(pidFile)});
setInterval(() => {}, 1 << 30);
`,
        { mode: 0o755 },
      );
      const PATH = `${bin}:${hermeticPath(join(scratch, 'tools'), ['node', 'git'])}`;
      const entry = spawn(process.execPath, [bundle], { cwd: repo.dir, env: { ...process.env, PATH }, stdio: ['ignore', 'ignore', 'pipe'] });
      spawned.push(entry);
      let stderr = '';
      entry.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => entry.on('close', (code, signal) => resolve({ code, signal })));
      let early = false;
      void exited.then(() => (early = true));
      while (!existsSync(pidFile) && !early) await delay(50);
      if (!existsSync(pidFile)) expect.fail(`the entry exited before starting the suite: ${stderr}`);
      const suitePid = Number(readFileSync(pidFile, 'utf8'));
      suitePids.push(suitePid);
      entry.kill(sent);
      while (!existsSync(ignoredFile) && !early) await delay(50);
      if (existsSync(ignoredFile)) expect.fail(`the suite was sent ${readFileSync(ignoredFile, 'utf8')}, which it ignores, so it outlives the proof`);
      const { code, signal } = await exited;
      expect.soft(isAlive(suitePid), 'the suite outlived the proof').toBe(false);
      expect.soft({ code, signal }, stderr).toEqual({ code: 1, signal: null });
      expect.soft(gh.read().statuses).toEqual([]);
      expect.soft(gh.read().comments['7'] ?? []).toEqual([]);
    },
    COMMAND_TIMEOUT_MS,
  );
});
