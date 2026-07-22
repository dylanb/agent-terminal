import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chainedInputState } from '../../src/main/chainedInputState';

// §27.10 — real fixtures, not a fake: the whole point of this classifier is that it tells "no upstream ran"
// apart from "its product is there but unavailable", which only real fs errno values exercise.
describe('chainedInputState (§27.10 — what the upstream loop left at a binding)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chained-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is produced for a regular file the upstream loop wrote', () => {
    const p = join(dir, 'plan.md');
    writeFileSync(p, '# plan\n');
    expect(chainedInputState(p)).toBe('produced');
  });

  it('is not-produced when nothing is at the binding (no upstream ran)', () => {
    expect(chainedInputState(join(dir, 'never-written.md'))).toBe('not-produced');
  });

  it('is unreadable — not not-produced — when a directory sits where the artifact belongs', () => {
    const p = join(dir, 'plan.md');
    mkdirSync(p);
    expect(chainedInputState(p)).toBe('unreadable');
  });

  it.skipIf(process.getuid?.() === 0)('is unreadable when an ancestor denies traversal', () => {
    const locked = join(dir, 'locked');
    mkdirSync(locked);
    const p = join(locked, 'plan.md');
    writeFileSync(p, '# plan\n');
    chmodSync(locked, 0o000);
    try {
      expect(chainedInputState(p)).toBe('unreadable');
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});
