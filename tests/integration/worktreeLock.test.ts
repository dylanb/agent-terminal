import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import {
  createWorktreeLock,
  currentLockHolder,
  MAX_ACQUIRE_ATTEMPTS,
  processStartTime,
  PROCESS_START_TIME_TIMEOUT_MS,
  selfLockHolder,
  serializeLockHolder,
  worktreeLockFile,
  type LockAcquire,
  type LockHolder,
} from '../../src/main/worktreeLock';
import { expectsUnidentifiedHolderRemedy, livenessByHolder, lockAlwaysPresentAtCreate } from '../helpers/lockDevices';
import { unidentifiedHolderRemedy } from '../helpers/lockRemedy';
import { displaySafeEcho, MAX_ECHOED_LOCK_REASON_LENGTH, MAX_ECHOED_PATH_LENGTH } from '../../src/shared/controlChars';

// A2 (#133) §18.7.4 AC11 — the cross-process worktree lock serializing flow:start and the active-flow pointer
// write. Real lockfiles on a real filesystem; real PIDs for the dead / live-mismatch holders. Every acquirer that
// meets a live holder names its liveness verdict, so no cause depends on the host's process table. A3 (#134) T6c as narrowed at impl round 2:
// only an unusable lock lets the critical section run without it.
const fileNamedIn = (refused: { ok: boolean; reason?: string }): string => {
  const named = /\bdelete (\/.+) and try again\./.exec(refused.reason ?? '')?.[1];
  if (named === undefined) throw new Error(`the refusal names no file to delete: ${JSON.stringify(refused)}`);
  return named;
};

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

    const second = createWorktreeLock({ lockRoot, holderLiveness: () => 'live-matching' }).acquire(wt);
    expect(second).toMatchObject({ ok: false, cause: 'held' });
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

  it('a critical section nested inside another on the same lock and worktree runs, while a peer stays refused', () => {
    const { lockRoot, wt } = setup();
    const lock = createWorktreeLock({ lockRoot, holderLiveness: () => 'live-matching' });
    const peer = createWorktreeLock({ lockRoot, holderLiveness: () => 'live-matching' });
    let peerSaw: LockAcquire | undefined;

    const outer = lock.withWorktreeLock(wt, () =>
      lock.withWorktreeLock(wt, () => {
        peerSaw = peer.acquire(wt);
        return 'inner ran';
      }),
    );

    expect(outer).toEqual({ ok: true, value: { ok: true, value: 'inner ran' } });
    expect(peerSaw).toMatchObject({ ok: false, cause: 'held' });
    expect(peer.acquire(wt).ok).toBe(true);
  });

  it('withWorktreeLock refuses without running the critical section while the lock is held', () => {
    const { lockRoot, wt } = setup();
    const held = createWorktreeLock({ lockRoot }).acquire(wt);
    expect(held.ok).toBe(true);
    let ran = false;

    const res = createWorktreeLock({ lockRoot, holderLiveness: () => 'live-matching' }).withWorktreeLock(wt, () => {
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

    const got = createWorktreeLock({ lockRoot, holderLiveness: () => 'live-matching' }).acquire(wt);
    expect(got).toMatchObject({ ok: false, cause: 'held' });
    if (!got.ok) {
      expect(got.reason).not.toContain(unidentifiedHolderRemedy(file).path);
      expect(got.reason).not.toMatch(unidentifiedHolderRemedy(file).deletes);
    }
    expect(readFileSync(file)).toEqual(before);
  });

  it("a start-time probe that fails once does not leave this process's later lockfiles unidentifiable", () => {
    let probes = 0;
    const holder = selfLockHolder(() => (probes++ === 0 ? null : 'Mon Sep 27 10:00:00 2026'));

    expect(holder().startTime).toBeNull();
    expect(holder()).toEqual({ pid: process.pid, startTime: 'Mon Sep 27 10:00:00 2026' });
    expect(holder()).toEqual({ pid: process.pid, startTime: 'Mon Sep 27 10:00:00 2026' });
  });

  it('a holder whose identity cannot be read is never reclaimed, and the critical section does not run', () => {
    const { lockRoot, wt } = setup();
    const file = plant(lockRoot, wt, { pid: process.pid, startTime: 'whatever' });
    const before = readFileSync(file);
    const lock = createWorktreeLock({ lockRoot, holderLiveness: () => 'unreadable' });

    expect(lock.acquire(wt)).toMatchObject({ ok: false, cause: 'holder-unreadable' });
    let ran = false;
    const got = lock.withWorktreeLock(wt, () => {
      ran = true;
    });
    expect(got.ok).toBe(false);
    if (!got.ok) expectsUnidentifiedHolderRemedy(got.reason, file);
    expect(ran).toBe(false);
    expect(readFileSync(file)).toEqual(before);
  });

  it("deleting the file an unidentified holder's refusal names and trying again runs the critical section", () => {
    const { lockRoot, wt } = setup();
    plant(lockRoot, wt, { pid: process.pid, startTime: 'whatever' });
    const lock = createWorktreeLock({ lockRoot, holderLiveness: () => 'unreadable' });
    const refused = lock.withWorktreeLock(wt, () => 'ran');

    rmSync(fileNamedIn(refused));

    expect(lock.withWorktreeLock(wt, () => 'ran')).toEqual({ ok: true, value: 'ran' });
  });

  describe("an unidentified holder's lockfile path that cannot be shown as it is", () => {
    const refusedUnder = (home: string): { reason: string; file: string } => {
      const lockRoot = join(home, 'locks');
      const wt = fx.makeWorktree('a3-lock-unshowable');
      const file = plant(lockRoot, wt, { pid: process.pid, startTime: 'whatever' });
      const got = createWorktreeLock({ lockRoot, holderLiveness: () => 'unreadable' }).acquire(wt);
      return { reason: got.ok ? '' : got.reason, file };
    };

    it.each([
      ['carries bidi and zero-width characters', () => fx.outsideDir(`a3-lock-home-\u202Ehostile\u200B-`)],
      [
        'is longer than the echo bound',
        () => {
          let dir = fx.outsideDir('a3-lock-long-home');
          while (dir.length <= MAX_ECHOED_PATH_LENGTH) dir = join(dir, 'd'.repeat(200));
          mkdirSync(dir, { recursive: true });
          return dir;
        },
      ],
    ])('%s: the reason names the lockfile by its name alone, never an altered or cut path, and stays bounded', (_, home) => {
      const { reason, file } = refusedUnder(home());

      const remedy = unidentifiedHolderRemedy(file);
      expect(reason).toContain(basename(remedy.path));
      expect(reason).toMatch(remedy.deletes);
      expect(reason).toMatch(remedy.retries);
      expect(reason).not.toContain(displaySafeEcho(dirname(remedy.path), MAX_ECHOED_PATH_LENGTH));
      expect(reason).not.toMatch(/[\u202E\u200B]/u);
      expect(reason.length).toBeLessThanOrEqual(MAX_ECHOED_LOCK_REASON_LENGTH);
    });
  });

  it('two acquirers that both find the same stale lock: exactly one wins the reclaim', async () => {
    const { lockRoot, wt } = setup();
    const stale: LockHolder = { pid: await deadPid(), startTime: 'not-a-real-start-time' };
    plant(lockRoot, wt, stale);
    const liveness = livenessByHolder([[stale, 'dead']], 'live-matching');
    let second: LockAcquire | undefined;
    const lockB = createWorktreeLock({ lockRoot, holderLiveness: liveness });
    const lockA = createWorktreeLock({
      lockRoot,
      holderLiveness: liveness,
      // A has judged the lock stale but not yet reclaimed it; B now finds the same stale lock and reclaims.
      beforeReclaim: () => {
        second ??= lockB.acquire(wt);
      },
    });

    const first = lockA.acquire(wt);

    expect(second).toBeDefined();
    expect([first.ok, second!.ok].filter(Boolean)).toHaveLength(1);
  });
  it('a lock write that faults after the file is created leaves nothing behind, and the critical section runs without the lock', () => {
    const { lockRoot, wt } = setup();
    const diskFull = (file: string): void => {
      writeFileSync(file, '', { flag: 'wx' });
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    };
    const lock = createWorktreeLock({ lockRoot, holderLiveness: () => 'live-matching', writeNewFile: diskFull });

    const got = lock.acquire(wt);

    expect(got).toMatchObject({ ok: false, cause: 'lock-unusable' });
    if (!got.ok) expect(got.reason).toMatch(/no space left/);
    expect(readdirSync(lockRoot)).toEqual([]);
    expect(lock.withWorktreeLock(wt, () => 'ran')).toEqual({ ok: true, value: 'ran' });
    expect(readdirSync(lockRoot)).toEqual([]);
    expect(createWorktreeLock({ lockRoot }).acquire(wt).ok).toBe(true);
  });

  it("a lock write that faults while a live peer holds the lock refuses as held, never running the critical section", () => {
    const { lockRoot, wt } = setup();
    const peer = plant(lockRoot, wt, { pid: process.pid, startTime: 'peer' });
    const diskFull = (): void => {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    };
    const lock = createWorktreeLock({ lockRoot, holderLiveness: () => 'live-matching', writeNewFile: diskFull });
    let ran = false;

    expect(lock.acquire(wt)).toMatchObject({ ok: false, cause: 'held' });
    expect(lock.withWorktreeLock(wt, () => (ran = true)).ok).toBe(false);
    expect(ran).toBe(false);
    expect(readFileSync(peer, 'utf8')).toBe(serializeLockHolder({ pid: process.pid, startTime: 'peer' }));
  });

  it('a lock write that faults while an unidentifiable holder has the lock refuses with the delete-and-retry remedy', () => {
    const { lockRoot, wt } = setup();
    const held = plant(lockRoot, wt, { pid: process.pid, startTime: 'peer' });
    const diskFull = (): void => {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    };

    const got = createWorktreeLock({ lockRoot, holderLiveness: () => 'unreadable', writeNewFile: diskFull }).acquire(wt);

    expect(got).toMatchObject({ ok: false, cause: 'holder-unreadable' });
    expectsUnidentifiedHolderRemedy(got.ok ? '' : got.reason, held);
  });

  it('a lock-unusable reason carrying a hostile, overlong fault is display-safe and bounded (§18.7.6)', () => {
    const { lockRoot, wt } = setup();
    const hostileFault = (): void => {
      throw new Error(`EIO: ‮txt.exe​\u0007 ${'x'.repeat(2 * MAX_ECHOED_LOCK_REASON_LENGTH)}`);
    };
    const got = createWorktreeLock({ lockRoot, holderLiveness: () => 'live-matching', writeNewFile: hostileFault }).acquire(wt);

    expect(got).toMatchObject({ ok: false, cause: 'lock-unusable' });
    const reason = got.ok ? '' : got.reason;
    expect(reason).toMatch(/EIO/);
    expect(reason).not.toMatch(/[‮​\u0000-\u001F]/);
    expect(reason.length).toBeLessThanOrEqual(MAX_ECHOED_LOCK_REASON_LENGTH);
  });

  it('a lock root that is a regular file reads lock-unusable, and the critical section runs without the lock, leaving the file unchanged', () => {
    const { lockRoot, wt } = setup();
    mkdirSync(dirname(lockRoot), { recursive: true });
    writeFileSync(lockRoot, 'not a directory\n');
    const lock = createWorktreeLock({ lockRoot, holderLiveness: () => 'live-matching' });

    expect(lock.acquire(wt)).toMatchObject({ ok: false, cause: 'lock-unusable' });
    expect(lock.withWorktreeLock(wt, () => 'ran')).toEqual({ ok: true, value: 'ran' });
    expect(readFileSync(lockRoot, 'utf8')).toBe('not a directory\n');
  });

  describe('retry exhaustion names the cause from everything the attempts observed', () => {
    const DEAD: LockHolder = { pid: 2_147_000_001, startTime: 'planted-dead' };
    const GUARD: LockHolder = { pid: 2_147_000_002, startTime: 'planted-guard' };

    const plantGuard = (lockRoot: string, wt: string, holder: LockHolder): string => {
      const guard = `${worktreeLockFile(lockRoot, wt)}.reclaim`;
      writeFileSync(guard, serializeLockHolder(holder));
      return guard;
    };

    const exhaust = (
      lockRoot: string,
      wt: string,
      liveness: (holder: LockHolder) => 'dead' | 'live-matching' | 'live-mismatch' | 'unreadable',
      beforeReclaim: () => void,
    ): LockAcquire => createWorktreeLock({ lockRoot, holderLiveness: liveness, beforeReclaim }).acquire(wt);

    const runs = (lockRoot: string, wt: string, liveness: (holder: LockHolder) => 'dead' | 'live-matching' | 'live-mismatch' | 'unreadable', beforeReclaim: () => void = () => {}): boolean => {
      let ran = false;
      createWorktreeLock({ lockRoot, holderLiveness: liveness, beforeReclaim }).withWorktreeLock(wt, () => {
        ran = true;
      });
      return ran;
    };

    it('a live-matching reclaim guard over a dead holder is held, and the critical section does not run', () => {
      const { lockRoot, wt } = setup();
      const file = plant(lockRoot, wt, DEAD);
      const guard = plantGuard(lockRoot, wt, GUARD);
      const before = [readFileSync(file), readFileSync(guard)];
      const liveness = livenessByHolder([[DEAD, 'dead'], [GUARD, 'live-matching']], 'live-matching');

      const got = exhaust(lockRoot, wt, liveness, () => {});

      expect(got).toMatchObject({ ok: false, cause: 'held' });
      expect(runs(lockRoot, wt, liveness)).toBe(false);
      expect([readFileSync(file), readFileSync(guard)]).toEqual(before);
    });

    it('a dead reclaim guard over a dead holder is cleared, and the lock is acquired', () => {
      const { lockRoot, wt } = setup();
      plant(lockRoot, wt, DEAD);
      const guard = plantGuard(lockRoot, wt, GUARD);
      const liveness = livenessByHolder([[DEAD, 'dead'], [GUARD, 'dead']], 'live-matching');

      const got = exhaust(lockRoot, wt, liveness, () => {});

      expect(got).toMatchObject({ ok: true });
      if (got.ok) got.release();
      expect(existsSync(guard)).toBe(false);
    });

    it('an unreadable reclaim guard over a dead holder is holder-unreadable, and the critical section does not run', () => {
      const { lockRoot, wt } = setup();
      const file = plant(lockRoot, wt, DEAD);
      const guard = plantGuard(lockRoot, wt, GUARD);
      const before = [readFileSync(file), readFileSync(guard)];
      const liveness = livenessByHolder([[DEAD, 'dead'], [GUARD, 'unreadable']], 'live-matching');

      const got = exhaust(lockRoot, wt, liveness, () => {});

      expect(got).toMatchObject({ ok: false, cause: 'holder-unreadable' });
      if (!got.ok) expectsUnidentifiedHolderRemedy(got.reason, guard);
      expect(runs(lockRoot, wt, liveness)).toBe(false);
      expect([readFileSync(file), readFileSync(guard)]).toEqual(before);
    });

    it("deleting the reclaim guard an unidentified holder's refusal names and trying again runs the critical section", () => {
      const { lockRoot, wt } = setup();
      plant(lockRoot, wt, DEAD);
      plantGuard(lockRoot, wt, GUARD);
      const lock = createWorktreeLock({
        lockRoot,
        holderLiveness: livenessByHolder([[DEAD, 'dead'], [GUARD, 'unreadable']], 'live-matching'),
      });
      const refused = lock.withWorktreeLock(wt, () => 'ran');

      rmSync(fileNamedIn(refused));

      expect(lock.withWorktreeLock(wt, () => 'ran')).toEqual({ ok: true, value: 'ran' });
    });

    it('reclaims lost to a dead holder re-planted on every attempt are lock-unusable, and the critical section runs', () => {
      const { lockRoot, wt } = setup();
      const holders: LockHolder[] = Array.from({ length: 2 * MAX_ACQUIRE_ATTEMPTS + 2 }, (_, n) => ({
        pid: 2_147_000_100 + n,
        startTime: `planted-dead-${n}`,
      }));
      const liveness = livenessByHolder(
        holders.map((h) => [h, 'dead'] as const),
        'live-matching',
      );
      let next = 0;
      const replant = (): void => {
        plant(lockRoot, wt, holders[++next]);
      };
      plant(lockRoot, wt, holders[0]);

      const got = exhaust(lockRoot, wt, liveness, replant);

      expect(got).toMatchObject({ ok: false, cause: 'lock-unusable' });
      expect(runs(lockRoot, wt, liveness, replant)).toBe(true);
      expect(existsSync(`${worktreeLockFile(lockRoot, wt)}.reclaim`)).toBe(false);
    });

    describe('every attempt is spent before exhaustion, and none past it', () => {
      const guardClearedAtReclaim = (lockRoot: string, wt: string, n: number): LockAcquire => {
        plant(lockRoot, wt, DEAD);
        const guard = plantGuard(lockRoot, wt, GUARD);
        let reclaims = 0;
        const liveness = livenessByHolder([[DEAD, 'dead'], [GUARD, 'live-matching']], 'live-matching');
        return exhaust(lockRoot, wt, liveness, () => {
          if (++reclaims === n) rmSync(guard);
        });
      };

      const presentAtFirstCreates = (n: number): ((file: string, content: string) => void) => {
        let creates = 0;
        return (file, content) => {
          if (++creates <= n) throw Object.assign(new Error(`EEXIST: file already exists, open '${file}'`), { code: 'EEXIST' });
          writeFileSync(file, content, { flag: 'wx' });
        };
      };

      it('a live reclaim guard that leaves before the last attempt yields the lock', () => {
        const { lockRoot, wt } = setup();
        expect(guardClearedAtReclaim(lockRoot, wt, MAX_ACQUIRE_ATTEMPTS - 1).ok).toBe(true);
      });

      it('a live reclaim guard that leaves only at the last attempt is held', () => {
        const { lockRoot, wt } = setup();
        expect(guardClearedAtReclaim(lockRoot, wt, MAX_ACQUIRE_ATTEMPTS)).toMatchObject({ ok: false, cause: 'held' });
      });

      it('a lock that vanishes on every create but the last yields the lock', () => {
        const { lockRoot, wt } = setup();
        const lock = createWorktreeLock({ lockRoot, holderLiveness: () => 'live-matching', writeNewFile: presentAtFirstCreates(MAX_ACQUIRE_ATTEMPTS - 1) });
        expect(lock.acquire(wt).ok).toBe(true);
      });

      it('a lock that vanishes on every create is held', () => {
        const { lockRoot, wt } = setup();
        const lock = createWorktreeLock({ lockRoot, holderLiveness: () => 'live-matching', writeNewFile: presentAtFirstCreates(MAX_ACQUIRE_ATTEMPTS) });
        expect(lock.acquire(wt)).toMatchObject({ ok: false, cause: 'held' });
      });
    });

    it('a lock that vanishes between every create and read is held, and the critical section does not run', () => {
      const { lockRoot, wt } = setup();
      const device = lockAlwaysPresentAtCreate();
      const lock = createWorktreeLock({ lockRoot, holderLiveness: () => 'live-matching', writeNewFile: device.writeNewFile });

      const got = lock.acquire(wt);

      expect(got).toMatchObject({ ok: false, cause: 'held' });
      let ran = false;
      lock.withWorktreeLock(wt, () => {
        ran = true;
      });
      expect(ran).toBe(false);
      expect(readdirSync(lockRoot)).toEqual([]);
    });
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
