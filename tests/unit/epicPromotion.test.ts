import { describe, expect, it, vi } from 'vitest';
import { createEpicPromotionCoordinator, type EpicPromotionCoordinatorDeps } from '../../src/main/epicPromotion';
import type { LoopDefV2 } from '../../src/main/loopDefV2';
import type { EpicSubTicket } from '../../src/shared/epicPlan';

// §28.7 — the epic-promotion coordinator: a gate-decision-time confirm-first hold. maybeBegin intercepts an
// approve on an epic plan (raise the preview, hold, do NOT accept); resolve completes it — confirm runs the
// promotion then accepts + stands the flow down, decline drops it and leaves the gate. Mirrors the
// bootstrap-conflict coordinator's held/resolve pattern.

const DEF = {} as LoopDefV2;
const SUBS: EpicSubTicket[] = [
  { index: 1, title: 'Slice one', body: 'Acceptance criteria: a\n\nplan one' },
  { index: 2, title: 'Slice two', body: 'Acceptance criteria: b\n\nplan two' },
];

function harness(over: Partial<EpicPromotionCoordinatorDeps> = {}) {
  const deps: EpicPromotionCoordinatorDeps = {
    readSubTickets: vi.fn(() => SUBS),
    emitPreview: vi.fn(),
    runPromotion: vi.fn(() => Promise.resolve()),
    accept: vi.fn(),
    audit: vi.fn(),
    emitError: vi.fn(),
    onViewChanged: vi.fn(),
    ...over,
  };
  return { deps, coord: createEpicPromotionCoordinator(deps) };
}

describe('maybeBegin — intercept an approve on an epic plan (§28.7)', () => {
  it('holds and emits the preview naming every sub-ticket, without accepting', () => {
    const { deps, coord } = harness();
    const intercepted = coord.maybeBegin('/repo', DEF, 'plan-bundle-loop', 'plan-bundle', 'consolidate-plan-bundle', { epic: 176, pr: 77 });
    expect(intercepted).toBe(true);
    expect(deps.emitPreview).toHaveBeenCalledWith({
      repoDir: '/repo', step: 'plan-bundle', epic: 176, pr: 77,
      subTickets: [{ index: 1, title: 'Slice one' }, { index: 2, title: 'Slice two' }],
    });
    expect(deps.accept).not.toHaveBeenCalled(); // held pending confirm — nothing accepted yet
  });

  it('does not intercept a non-epic plan (readSubTickets null)', () => {
    const { deps, coord } = harness({ readSubTickets: vi.fn(() => null) });
    expect(coord.maybeBegin('/repo', DEF, 'l', 's', 't', { epic: 176, pr: 77 })).toBe(false);
    expect(deps.emitPreview).not.toHaveBeenCalled();
  });

  it('does not intercept when the epic issue number is unknown (cannot promote)', () => {
    const { deps, coord } = harness();
    expect(coord.maybeBegin('/repo', DEF, 'l', 's', 't', { epic: null, pr: 77 })).toBe(false);
    expect(deps.emitPreview).not.toHaveBeenCalled();
  });
});

describe('resolve — complete the held promotion (§28.7)', () => {
  it('confirm runs the promotion then accepts + stands the flow down', async () => {
    const { deps, coord } = harness();
    coord.maybeBegin('/repo', DEF, 'plan-bundle-loop', 'plan-bundle', 'consolidate-plan-bundle', { epic: 176, pr: 77 });
    await coord.resolve('/repo', 'plan-bundle', true);
    expect(deps.runPromotion).toHaveBeenCalledWith('/repo', { epic: 176, pr: 77, subTickets: SUBS });
    expect(deps.accept).toHaveBeenCalledWith('/repo', 'plan-bundle-loop', 'plan-bundle', 'consolidate-plan-bundle');
    expect(deps.onViewChanged).toHaveBeenCalled();
  });

  it('decline drops the promotion and leaves the gate — nothing promoted, nothing accepted', async () => {
    const { deps, coord } = harness();
    coord.maybeBegin('/repo', DEF, 'plan-bundle-loop', 'plan-bundle', 'consolidate-plan-bundle', { epic: 176, pr: 77 });
    await coord.resolve('/repo', 'plan-bundle', false);
    expect(deps.runPromotion).not.toHaveBeenCalled();
    expect(deps.accept).not.toHaveBeenCalled();
    expect(deps.onViewChanged).toHaveBeenCalled(); // re-render the still-actionable gate
  });

  it('a resolve with no pending promotion is inert (a raced/stale answer)', async () => {
    const { deps, coord } = harness();
    await coord.resolve('/repo', 'plan-bundle', true);
    expect(deps.runPromotion).not.toHaveBeenCalled();
    expect(deps.accept).not.toHaveBeenCalled();
  });

  it('a second resolve after the first is inert (the hold is cleared once answered)', async () => {
    const { deps, coord } = harness();
    coord.maybeBegin('/repo', DEF, 'plan-bundle-loop', 'plan-bundle', 'consolidate-plan-bundle', { epic: 176, pr: 77 });
    await coord.resolve('/repo', 'plan-bundle', true);
    await coord.resolve('/repo', 'plan-bundle', true);
    expect(deps.runPromotion).toHaveBeenCalledTimes(1);
    expect(deps.accept).toHaveBeenCalledTimes(1);
  });

  it('re-reads the plan at confirm (re-authorization): a plan no longer epic aborts without accepting', async () => {
    const readSubTickets = vi.fn().mockReturnValueOnce(SUBS).mockReturnValueOnce(null);
    const { deps, coord } = harness({ readSubTickets });
    coord.maybeBegin('/repo', DEF, 'plan-bundle-loop', 'plan-bundle', 'consolidate-plan-bundle', { epic: 176, pr: 77 });
    await coord.resolve('/repo', 'plan-bundle', true);
    expect(deps.runPromotion).not.toHaveBeenCalled();
    expect(deps.accept).not.toHaveBeenCalled();
    expect(deps.emitError).toHaveBeenCalled();
  });
});
