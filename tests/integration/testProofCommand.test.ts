import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
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
});
