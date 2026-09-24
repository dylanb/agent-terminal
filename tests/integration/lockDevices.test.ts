import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { holdLockAsPeer, livenessByHolder, lockAlwaysPresentAtCreate, tryPeerLockDuring } from '../helpers/lockDevices';
import { createWorktreeLock, currentLockHolder, serializeLockHolder, worktreeLockFile } from '../../src/main/worktreeLock';

// A3 (#134) — the lock contention and liveness devices the Lock-row tests build on, proven against the real
// worktree lock over real lockfiles, so a device that stops producing the contention it names fails here.
describe('lock devices (A3 #134)', () => {
  const fx = createWorktreeFixture();
  afterEach(() => fx.cleanup());

  const setup = (): { lockRoot: string; wt: string } => ({
    lockRoot: join(fx.outsideDir('a3-lock-home'), 'locks'),
    wt: fx.makeWorktree('a3-lock-wt'),
  });

  it('livenessByHolder answers the planted verdict for a planted holder and the fallback for any other', () => {
    const liveness = livenessByHolder(
      [
        [{ pid: 4242, startTime: 'planted-a' }, 'dead'],
        [{ pid: 4343, startTime: 'planted-b' }, 'unreadable'],
      ],
      'live-matching',
    );
    expect(liveness({ pid: 4242, startTime: 'planted-a' })).toBe('dead');
    expect(liveness({ pid: 4343, startTime: 'planted-b' })).toBe('unreadable');
    expect(liveness({ pid: 4444, startTime: 'y' })).toBe('live-matching');
    expect(liveness({ pid: 4242, startTime: 'y' })).toBe('live-matching');
  });

  it('livenessByHolder tells apart planted holders that share a start-time by their pid', () => {
    const liveness = livenessByHolder(
      [
        [{ pid: 4242, startTime: 'planted' }, 'dead'],
        [{ pid: 4343, startTime: 'planted' }, 'unreadable'],
      ],
      'live-matching',
    );
    expect(liveness({ pid: 4242, startTime: 'planted' })).toBe('dead');
    expect(liveness({ pid: 4343, startTime: 'planted' })).toBe('unreadable');
    expect(liveness({ pid: 4444, startTime: 'planted' })).toBe('live-matching');
  });

  it('livenessByHolder never gives this process\'s real holder a planted verdict, even when a planted holder shares its pid', () => {
    const liveness = livenessByHolder([[{ pid: process.pid, startTime: 'planted' }, 'dead']], 'live-matching');
    expect(liveness(currentLockHolder())).toBe('live-matching');
  });

  it('livenessByHolder drives the real lock: a planted dead holder is reclaimed, a live-matching one is not', () => {
    const { lockRoot, wt } = setup();
    const file = worktreeLockFile(lockRoot, wt);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, serializeLockHolder({ pid: 4242, startTime: 'planted' }));

    const refused = createWorktreeLock({ lockRoot, holderLiveness: livenessByHolder([], 'live-matching') }).acquire(wt);
    expect(refused.ok).toBe(false);

    const reclaimed = createWorktreeLock({ lockRoot, holderLiveness: livenessByHolder([[{ pid: 4242, startTime: 'planted' }, 'dead']], 'live-matching') }).acquire(wt);
    expect(reclaimed.ok).toBe(true);
  });

  it('lockAlwaysPresentAtCreate makes every create report EEXIST while no lockfile ever exists, so the acquire never runs the section', () => {
    const { lockRoot, wt } = setup();
    const device = lockAlwaysPresentAtCreate();
    let ran = false;
    let reclaims = 0;

    const got = createWorktreeLock({
      lockRoot,
      holderLiveness: () => 'live-matching',
      writeNewFile: device.writeNewFile,
      beforeReclaim: () => {
        reclaims++;
      },
    }).withWorktreeLock(wt, () => {
      ran = true;
    });

    expect(got.ok).toBe(false);
    expect(ran).toBe(false);
    expect(device.calls()).toBeGreaterThan(1);
    expect(reclaims).toBe(0);
  });

  it('holdLockAsPeer holds the worktree lock until released', () => {
    const { lockRoot, wt } = setup();
    const acquirer = createWorktreeLock({ lockRoot, holderLiveness: () => 'live-matching' });
    const release = holdLockAsPeer(lockRoot, wt);

    expect(acquirer.acquire(wt).ok).toBe(false);
    release();
    expect(acquirer.acquire(wt).ok).toBe(true);
  });

  it('tryPeerLockDuring observes a refusal when the wrapped write runs inside the lock, and passes args and result through', () => {
    const { lockRoot, wt } = setup();
    const probe = tryPeerLockDuring(lockRoot, wt);
    const write = probe.wrap((a: number, b: number) => a + b);

    const locked = createWorktreeLock({ lockRoot, holderLiveness: () => 'live-matching' }).withWorktreeLock(wt, () => write(2, 3));

    expect(locked).toEqual({ ok: true, value: 5 });
    expect(probe.observed()).toHaveLength(1);
    expect(probe.observed()[0].ok).toBe(false);
  });

  it('tryPeerLockDuring observes a successful acquire when the write runs outside any lock, and leaves the lock free', () => {
    const { lockRoot, wt } = setup();
    const probe = tryPeerLockDuring(lockRoot, wt);

    probe.wrap(() => undefined)();

    expect(probe.observed()).toHaveLength(1);
    expect(probe.observed()[0].ok).toBe(true);
    expect(createWorktreeLock({ lockRoot, holderLiveness: () => 'live-matching' }).acquire(wt).ok).toBe(true);
  });
});
