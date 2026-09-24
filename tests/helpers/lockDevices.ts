// Lock contention and liveness devices for the A3 (#134) Lock-row tests: every acquirer a test builds names its
// liveness verdict, so no result depends on the host's process table.

import {
  createWorktreeLock,
  type HolderLiveness,
  type LockAcquire,
  type LockHolder,
} from '../../src/main/worktreeLock';

/** A peer acquire as the probe saw it — a refusal verbatim, a success without its release. */
export type PeerAcquire = { ok: true } | Extract<LockAcquire, { ok: false }>;

/** Liveness that answers the planted verdict for a holder matching a planted one on pid AND start-time, and
 *  `fallback` for every other holder. A planted start-time no process reports (e.g. `planted`) keeps a planted
 *  pid that equals this worker's own pid from handing the real holder the planted verdict. */
export function livenessByHolder(
  planted: ReadonlyArray<readonly [LockHolder, HolderLiveness]>,
  fallback: HolderLiveness,
): (holder: LockHolder) => HolderLiveness {
  return (holder) =>
    planted.find(([p]) => p.pid === holder.pid && p.startTime === holder.startTime)?.[1] ?? fallback;
}

/** A `writeNewFile` device whose every exclusive create fails with EEXIST although no lockfile exists — a peer
 *  that creates and releases the lock between each create and the read that follows it. */
export function lockAlwaysPresentAtCreate(): { writeNewFile: (file: string, content: string) => void; calls(): number } {
  let calls = 0;
  return {
    writeNewFile(file) {
      calls++;
      throw Object.assign(new Error(`EEXIST: file already exists, open '${file}'`), { code: 'EEXIST' });
    },
    calls: () => calls,
  };
}

/** Take the worktree's lock as a second app instance would, holding it until the returned release is called. */
export function holdLockAsPeer(lockRoot: string, worktree: string): () => void {
  const got = createWorktreeLock({ lockRoot, holderLiveness: () => 'live-matching' }).acquire(worktree);
  if (!got.ok) throw new Error(`peer could not take the worktree lock: ${got.reason}`);
  return got.release;
}

/** Wraps a write so that, at the moment it runs, a live-matching peer tries the same worktree's lock (releasing
 *  it again if it got it) and records what it saw — the observation that the write happened inside the lock. */
export function tryPeerLockDuring(
  lockRoot: string,
  worktree: string,
): { wrap<A extends unknown[], R>(write: (...args: A) => R): (...args: A) => R; observed(): PeerAcquire[] } {
  const seen: PeerAcquire[] = [];
  const peer = createWorktreeLock({ lockRoot, holderLiveness: () => 'live-matching' });
  return {
    wrap(write) {
      return (...args) => {
        const got = peer.acquire(worktree);
        if (got.ok) {
          got.release();
          seen.push({ ok: true });
        } else {
          seen.push(got);
        }
        return write(...args);
      };
    },
    observed: () => [...seen],
  };
}
