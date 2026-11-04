import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
