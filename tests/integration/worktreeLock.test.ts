import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import {
  createWorktreeLock,
  currentLockHolder,
  processStartTime,
  PROCESS_START_TIME_TIMEOUT_MS,
  serializeLockHolder,
  worktreeLockFile,
  type LockHolder,
} from '../../src/main/worktreeLock';

// A2 (#133) §18.7.4 AC11 — the cross-process worktree lock serializing flow:start and the active-flow pointer
// write. Real lockfiles on a real filesystem; real PIDs for the dead / live-matching / live-mismatch holders. Only
// the environment-dependent start-time READ FAILURE uses the injected holderLiveness concept.
describe('worktree lock (§18.7.4 AC11)', () => {
  const fx = createWorktreeFixture();
  afterEach(() => fx.cleanup());

  const setup = (): { lockRoot: string; wt: string } => {
    const home = fx.outsideDir('a2-lock-home');
    return { lockRoot: join(home, 'locks'), wt: fx.makeWorktree('a2-lock-wt') };
  };

  const plant = (lockRoot: string, wt: string, holder: LockHolder): string => {
    const file = worktreeLockFile(lockRoot, wt);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, serializeLockHolder(holder));
    return file;
  };

  const deadPid = async (): Promise<number> => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const pid = child.pid!;
    child.kill('SIGKILL');
    await once(child, 'exit');
    return pid;
  };

  it('a first acquire on a fresh app home creates the lock container and succeeds', () => {
    const { lockRoot, wt } = setup();
    rmSync(dirname(lockRoot), { recursive: true, force: true }); // the lock's ground does not exist yet

    const got = createWorktreeLock({ lockRoot }).acquire(wt);

    expect(got.ok).toBe(true);
    expect(existsSync(worktreeLockFile(lockRoot, wt))).toBe(true);
  });

  it('fails fast while another holder has the lock, and succeeds once it is released', () => {
    const { lockRoot, wt } = setup();
    const first = createWorktreeLock({ lockRoot }).acquire(wt);
    expect(first.ok).toBe(true);

    const second = createWorktreeLock({ lockRoot }).acquire(wt);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toMatch(/\S/);

    if (first.ok) first.release();
    expect(createWorktreeLock({ lockRoot }).acquire(wt).ok).toBe(true);
  });

  it('a different worktree has its own lock', () => {
    const { lockRoot, wt } = setup();
    const other = fx.makeWorktree('a2-lock-other');
    expect(createWorktreeLock({ lockRoot }).acquire(wt).ok).toBe(true);
    expect(createWorktreeLock({ lockRoot }).acquire(other).ok).toBe(true);
  });

  it('withWorktreeLock releases the lock when the critical section throws', () => {
    const { lockRoot, wt } = setup();
    const lock = createWorktreeLock({ lockRoot });

    expect(() =>
      lock.withWorktreeLock(wt, () => {
        throw new Error('illegal flow transition');
      }),
    ).toThrow('illegal flow transition');

    expect(lock.acquire(wt).ok).toBe(true);
  });

  it('withWorktreeLock refuses without running the critical section while the lock is held', () => {
    const { lockRoot, wt } = setup();
    const held = createWorktreeLock({ lockRoot }).acquire(wt);
    expect(held.ok).toBe(true);
    let ran = false;

    const res = createWorktreeLock({ lockRoot }).withWorktreeLock(wt, () => {
      ran = true;
      return 1;
    });

    expect(res.ok).toBe(false);
    expect(ran).toBe(false);
  });

  it('reclaims a lock left by a dead holder', async () => {
    const { lockRoot, wt } = setup();
    // A bogus start-time too, so reclaim still fires via the mismatch leg if the OS reuses the dead PID.
    plant(lockRoot, wt, { pid: await deadPid(), startTime: 'not-a-real-start-time' });

    expect(createWorktreeLock({ lockRoot }).acquire(wt).ok).toBe(true);
  });

  it('reclaims a lock naming a live PID whose recorded start-time does not match that process', () => {
    const { lockRoot, wt } = setup();
    plant(lockRoot, wt, { pid: process.pid, startTime: 'planted-start-time' });

    expect(createWorktreeLock({ lockRoot }).acquire(wt).ok).toBe(true);
  });

  it('never reclaims a lock whose live holder matches its recorded identity', () => {
    const { lockRoot, wt } = setup();
    const file = plant(lockRoot, wt, currentLockHolder());
    const before = readFileSync(file);

    expect(createWorktreeLock({ lockRoot }).acquire(wt).ok).toBe(false);
    expect(readFileSync(file)).toEqual(before);
  });

  it('treats a holder whose identity cannot be read as present (fail-closed, never reclaimed)', () => {
    const { lockRoot, wt } = setup();
    const file = plant(lockRoot, wt, { pid: process.pid, startTime: 'whatever' });
    const before = readFileSync(file);

    const got = createWorktreeLock({ lockRoot, holderLiveness: () => 'unreadable' }).acquire(wt);

    expect(got.ok).toBe(false);
    expect(readFileSync(file)).toEqual(before);
  });

  it('two acquirers that both find the same stale lock: exactly one wins the reclaim', async () => {
    const { lockRoot, wt } = setup();
    plant(lockRoot, wt, { pid: await deadPid(), startTime: 'not-a-real-start-time' });
    let second: ReturnType<ReturnType<typeof createWorktreeLock>['acquire']> | undefined;
    const lockB = createWorktreeLock({ lockRoot });
    const lockA = createWorktreeLock({
      lockRoot,
      // A has judged the lock stale but not yet reclaimed it; B now finds the same stale lock and reclaims.
      beforeReclaim: () => {
        second ??= lockB.acquire(wt);
      },
    });

    const first = lockA.acquire(wt);

    expect(second).toBeDefined();
    expect([first.ok, second!.ok].filter(Boolean)).toHaveLength(1);
  });
  it('a lock write that faults after the file is created refuses and leaves nothing behind in the lock directory', () => {
    const { lockRoot, wt } = setup();
    const diskFull = (file: string): void => {
      writeFileSync(file, '', { flag: 'wx' });
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    };

    const got = createWorktreeLock({ lockRoot, writeNewFile: diskFull }).acquire(wt);

    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toMatch(/no space left/);
    expect(readdirSync(lockRoot)).toEqual([]);
    expect(createWorktreeLock({ lockRoot }).acquire(wt).ok).toBe(true);
  });

  it.skipIf(process.platform !== 'darwin')(
    'a hung start-time probe is abandoned within its timeout and reads as unknown',
    () => {
      const bin = fx.outsideDir('a2-lock-hung-ps');
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, 'ps'), '#!/bin/sh\nexec sleep 30\n');
      chmodSync(join(bin, 'ps'), 0o755);
      const savedPath = process.env.PATH;
      process.env.PATH = `${bin}:${savedPath ?? ''}`;
      try {
        const began = Date.now();
        const startTime = processStartTime(process.pid);
        const elapsed = Date.now() - began;

        expect(startTime).toBeNull();
        expect(elapsed).toBeLessThan(PROCESS_START_TIME_TIMEOUT_MS + 5_000);
      } finally {
        process.env.PATH = savedPath;
      }
    },
    45_000,
  );
});
