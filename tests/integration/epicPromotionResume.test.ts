import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEpicPromotion, type AppEpicPromotionGitHub, type EpicPromotionStore } from '../../src/main/epicPromotion';
import { readEpicPromotion, writeEpicPromotion } from '../../src/main/appLoopState';

// §28.7 AC3 — the resume behavior the acceptance e2e cannot drive through the UI (the flow terminates after a
// successful confirm — INT-3): runEpicPromotion over the REAL promotion.yaml store is idempotent — a second run
// with the persisted record creates NOTHING. This closes "a re-run creates nothing" through real persistence.

let repo: string;
function fakeGh(start = 500) {
  const events: string[] = [];
  let next = start;
  const gh: AppEpicPromotionGitHub = {
    createIssue: async () => {
      next += 1;
      events.push(`create#${next}`);
      return next;
    },
    addLabel: async () => {},
    appendIssueBody: async () => void events.push('append'),
    closePr: async () => void events.push('closePr'),
  };
  return { gh, events };
}
const realStore = (): EpicPromotionStore => ({
  read: (epic) => readEpicPromotion(repo, epic),
  write: (state) => writeEpicPromotion(repo, state),
});
const REQUEST = {
  epic: 176,
  pr: 4242,
  subTickets: [
    { index: 1, title: 'Slice one', body: 'Acceptance criteria: a\n\nplan one' },
    { index: 2, title: 'Slice two', body: 'Acceptance criteria: b\n\nplan two' },
    { index: 3, title: 'Slice three', body: 'Acceptance criteria: c\n\nplan three' },
  ],
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'epic-promote-resume-'));
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('runEpicPromotion over the real store — resumable idempotency (§28.7 AC3)', () => {
  it('a second run with the persisted record creates NOTHING (re-run is idempotent)', async () => {
    const first = fakeGh();
    await runEpicPromotion(first.gh, REQUEST, realStore());
    expect(first.events.filter((e) => e.startsWith('create#'))).toHaveLength(3); // the chain was created + persisted

    const recorded = readEpicPromotion(repo, 176);
    expect(recorded).not.toBe('corrupt');
    expect(recorded).not.toBeNull();

    const second = fakeGh();
    await runEpicPromotion(second.gh, REQUEST, realStore());
    expect(second.events).toEqual([]); // no create, no label, no append, no close — the record made it a no-op
    expect(readEpicPromotion(repo, 176)).toEqual(recorded); // and the record is unchanged
  });

  it('a resume after a partial run (only slice 1 recorded) creates only the missing slices through the real store', async () => {
    // Seed the store as if a prior run created only slice 1.
    writeEpicPromotion(repo, { epic: 176, created: [{ index: 1, issue: 501, title: 'Slice one' }], trackingAppended: false, prClosed: false });
    const { gh, events } = fakeGh(600); // seed ABOVE the recorded #501 so a reuse-of-stale-number bug can't hide behind a collision
    await runEpicPromotion(gh, REQUEST, realStore());
    expect(events.filter((e) => e.startsWith('create#'))).toEqual(['create#601', 'create#602']); // slices 2 and 3, each its OWN fresh number
    expect(readEpicPromotion(repo, 176)).toMatchObject({ trackingAppended: true, prClosed: true });
  });

  it('a resumed record whose recorded split diverges from the plan is refused (defense-in-depth behind the gate-time block)', async () => {
    // The gate now blocks a stale record before the preview; this pins the executor guard that still refuses one
    // that went stale AFTER confirm — it must never orphan or mis-stack the recorded slice.
    writeEpicPromotion(repo, { epic: 176, created: [{ index: 1, issue: 501, title: 'A slice the plan no longer has' }], trackingAppended: false, prClosed: false });
    const { gh, events } = fakeGh(600);
    await expect(runEpicPromotion(gh, REQUEST, realStore())).rejects.toThrow('plan changed since a partial promotion');
    expect(events).toEqual([]); // refused before any GitHub mutation
  });
});
