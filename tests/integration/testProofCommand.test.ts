import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitRepoFixture, type GitRepoFixture } from '../helpers/gitRepo';
import { hermeticPath, installTestProofGh } from '../helpers/testProofGh';
import { makeProofRepo } from '../helpers/testProofSuites';

const ROOT = join(__dirname, '..', '..');
const COMMAND_TIMEOUT_MS = 120_000;

describe('pnpm run test:proof', () => {
  it(
    'refuses an argument, naming it as the cause',
    () => {
      const run = spawnSync('pnpm', ['run', 'test:proof', 'unexpected-arg'], { cwd: ROOT, encoding: 'utf8' });
      expect.soft(run.status).not.toBe(0);
      expect.soft(run.stderr).toContain('unexpected-arg');
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

  beforeAll(() => {
    const build = spawnSync('pnpm', ['exec', 'vite', 'build', '--config', 'vite.testProof.config.ts', '--logLevel', 'error'], { cwd: ROOT, encoding: 'utf8' });
    expect(build.status, build.stderr).toBe(0);
  }, COMMAND_TIMEOUT_MS);

  beforeEach(() => {
    git = createGitRepoFixture();
    scratch = mkdtempSync(join(tmpdir(), 'test-proof-entry-'));
  });

  afterEach(() => {
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

  it(
    'takes the running suite down with it when the entry alone is sent SIGTERM, and publishes nothing',
    async () => {
      const bin = join(scratch, 'bin');
      const repo = makeProofRepo(git, { bin, stateDir: join(scratch, 'state'), branch: 'feature/proof', electronVersion: '38.7.1' });
      const gh = installTestProofGh(bin, { pullRequests: [{ number: 7, headRefName: repo.branch, headRefOid: repo.head, isCrossRepository: false }] });
      const pidFile = join(scratch, 'suite.pid');
      writeFileSync(
        join(bin, 'pnpm'),
        `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1 << 30);\n`,
        { mode: 0o755 },
      );
      const PATH = `${bin}:${hermeticPath(join(scratch, 'tools'), ['node', 'git'])}`;
      const entry = spawn(process.execPath, [bundle], { cwd: repo.dir, env: { ...process.env, PATH }, stdio: 'ignore' });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => entry.on('close', (code, signal) => resolve({ code, signal })));
      let suitePid = 0;
      try {
        while (!existsSync(pidFile)) await delay(50);
        suitePid = Number(readFileSync(pidFile, 'utf8'));
        entry.kill('SIGTERM');
        const { code, signal } = await exited;
        const suiteAlive = (() => {
          try {
            process.kill(suitePid, 0);
            return true;
          } catch {
            return false;
          }
        })();
        expect.soft(suiteAlive, 'the suite outlived the proof').toBe(false);
        expect.soft({ code, signal }).toEqual({ code: 1, signal: null });
        expect.soft(gh.read().statuses).toEqual([]);
        expect.soft(gh.read().comments['7'] ?? []).toEqual([]);
      } finally {
        if (suitePid > 0) {
          try {
            process.kill(suitePid, 'SIGKILL');
          } catch {
            /* already gone */
          }
        }
        entry.kill('SIGKILL');
      }
    },
    COMMAND_TIMEOUT_MS,
  );
});
