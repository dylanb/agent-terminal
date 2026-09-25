// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFeed, createScriptedAsync, deferred, type Deferred } from '../helpers/scriptedCalls';
import { assertRendersFromHostDocument } from './relocatable';
import { createFlowPicker, type FlowPickerDeps } from '../../src/renderer/src/flowPicker';
import { createFlowStrip, type FlowStripDeps } from '../../src/renderer/src/flowStrip';
import type { FlowViewArgs } from '../../src/renderer/src/flowView';
import type { ActiveFlowWriteResult, FlowCatalogListResult, FlowStateView } from '../../src/shared/ipc';
import { MAX_ECHOED_REASON_LENGTH } from '../../src/shared/controlChars';

// A3 (#134) §18.7.4 / §18.7.6 — the flow picker organism in select mode. It follows the worktree of each view
// the strip fans out (AC2), and a pick asks for THAT worktree's pointer write (AC1).

const neverStarted = (steps: string[]): FlowStateView => ({
  stepName: steps[0] ?? '',
  steps,
  position: 1,
  total: steps.length,
  status: 'not_started',
  runStarted: 'never-started',
});

const listingOf = (ids: string[], selectedId?: string): FlowCatalogListResult => ({
  ok: true,
  listing: {
    entries: ids.map((id) => ({ available: true as const, id, origin: 'global' as const })),
    tierNotices: [],
    hasLocalFlow: false,
    hasGlobalFallback: false,
    resumable: ids.map((id) => ({ origin: 'global' as const, id })),
    ...(selectedId === undefined ? {} : { selectedId }),
  },
});

/** The catalog as main serves it: each worktree answers with its own listing, however often it is pulled, and a
 *  successful select is reflected in that worktree's next listing. `hold` parks the next pull for one worktree. */
function createCatalog() {
  const listings = new Map<string, FlowCatalogListResult>();
  const held = new Map<string, Deferred<FlowCatalogListResult>[]>();
  const pulls: string[] = [];
  return {
    serve(repoKey: string, result: FlowCatalogListResult): void {
      listings.set(repoKey, result);
    },
    hold(repoKey: string): Deferred<FlowCatalogListResult> {
      const d = deferred<FlowCatalogListResult>();
      held.set(repoKey, [...(held.get(repoKey) ?? []), d]);
      return d;
    },
    select(repoKey: string, id: string): void {
      const current = listings.get(repoKey);
      if (current?.ok) listings.set(repoKey, { ok: true, listing: { ...current.listing, selectedId: id } });
    },
    listCatalog(repoKey: string): Promise<FlowCatalogListResult> {
      pulls.push(repoKey);
      const next = held.get(repoKey)?.shift();
      if (next) return next.promise;
      const answer = listings.get(repoKey);
      return answer ? Promise.resolve(answer) : Promise.reject(new Error(`no listing served for ${repoKey}`));
    },
    pulls: () => [...pulls],
  };
}

function rig(views = createFeed<FlowViewArgs>()) {
  const catalog = createCatalog();
  const select = createScriptedAsync<[string, string], ActiveFlowWriteResult>();
  const clearSelection = createScriptedAsync<[string], ActiveFlowWriteResult>();
  const deps: FlowPickerDeps = {
    onView: (cb) => views.subscribe(cb),
    listCatalog: (repoKey) => catalog.listCatalog(repoKey),
    select: async (repoKey, id) => {
      const result = await select.call(repoKey, id);
      if (result.ok) catalog.select(repoKey, id);
      return result;
    },
    clearSelection: clearSelection.call,
  };
  const host = document.body.appendChild(document.createElement('div'));
  return { views, catalog, select, clearSelection, deps, host };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

function findTrigger(host: HTMLElement): HTMLButtonElement | undefined {
  return [...host.querySelectorAll('button')].find(
    (b) => /flow/i.test(b.textContent ?? '') || /flow/i.test(b.getAttribute('aria-label') ?? ''),
  );
}

function trigger(host: HTMLElement): HTMLButtonElement {
  const btn = findTrigger(host);
  expect(btn, 'the picker renders a trigger button naming the flow').toBeDefined();
  return btn!;
}

function options(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('[role="option"]')];
}

function option(host: HTMLElement, id: string): HTMLElement {
  const opt = options(host).find((o) => (o.textContent ?? '').includes(id));
  expect(opt, `an option for ${id}`).toBeDefined();
  return opt!;
}

/** Open the listbox unless it is already showing its rows — a picker may close it on a pick. */
async function ensureOpen(host: HTMLElement): Promise<void> {
  if (options(host).length > 0) return;
  trigger(host).click();
  await settle();
}

/** Clicks the trigger as a user could — an aria-disabled one still takes the click — unless rows already show. */
async function openIfClosed(host: HTMLElement): Promise<void> {
  const btn = findTrigger(host);
  if (options(host).length > 0 || !btn || btn.disabled) return;
  btn.click();
  await settle();
}

/** Clicks every row offered, re-querying after each open so a row rendered by a re-open is clicked too. */
async function pickEveryOfferedRow(host: HTMLElement): Promise<void> {
  for (let pass = 0; pass < 2; pass++) {
    await openIfClosed(host);
    for (const el of options(host)) el.click();
    await settle();
  }
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('flow picker — select mode (AC1)', () => {
  it("picking the second flow asks for that flow on the shown view's worktree", async () => {
    const r = rig();
    r.catalog.serve('/repo-a', listingOf(['flow-a', 'flow-b']));
    r.select.respond({ ok: true });
    const picker = createFlowPicker(r.host, r.deps);

    r.views.fire('/repo-a', neverStarted(['a1', 'a2']));
    await settle();
    expect(trigger(r.host).textContent).toBe('Flow: default');
    await ensureOpen(r.host);
    option(r.host, 'flow-b').click();
    await settle();

    expect(r.select.calls()).toEqual([['/repo-a', 'flow-b']]);
    expect(trigger(r.host).textContent).toBe('Flow: flow-b');
    await ensureOpen(r.host);
    expect(option(r.host, 'flow-b').getAttribute('aria-selected')).toBe('true');
    picker.dispose();
  });

  it('names every row by its flow and origin as separate words (WCAG 4.1.2)', async () => {
    const r = rig();
    r.catalog.serve('/repo-a', {
      ok: true,
      listing: {
        entries: [
          { available: true, id: 'flow-a', origin: 'repo' },
          { available: false, label: 'flow-x', origin: 'global', reason: 'escapes its tier' },
        ],
        tierNotices: [],
        hasLocalFlow: false,
        hasGlobalFallback: false,
        resumable: [{ origin: 'repo', id: 'flow-a' }],
      },
    });
    const picker = createFlowPicker(r.host, r.deps);
    r.views.fire('/repo-a', neverStarted(['a1']));
    await settle();
    await ensureOpen(r.host);

    const nameOf = (el: HTMLElement): string =>
      (el.getAttribute('aria-labelledby') ?? '')
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => r.host.ownerDocument.getElementById(id)?.textContent ?? '')
        .join(' ');
    expect(nameOf(option(r.host, 'flow-a'))).toBe('flow-a repo');
    expect(nameOf(option(r.host, 'flow-x'))).toBe('flow-x global');
    picker.dispose();
  });

  it("highlights the listing's selectedId without writing anything", async () => {
    const r = rig();
    r.catalog.serve('/repo-a', listingOf(['flow-a', 'flow-b'], 'flow-b'));
    const picker = createFlowPicker(r.host, r.deps);

    r.views.fire('/repo-a', neverStarted(['b1']));
    await settle();
    await ensureOpen(r.host);

    expect(option(r.host, 'flow-b').getAttribute('aria-selected')).toBe('true');
    expect(option(r.host, 'flow-a').getAttribute('aria-selected')).not.toBe('true');
    expect(r.select.calls()).toEqual([]);
    expect(r.clearSelection.calls()).toEqual([]);
    picker.dispose();
  });

  it('a refused pick announces its reason and restores the prior selection without re-pulling the listing', async () => {
    const r = rig();
    r.catalog.serve('/repo-a', listingOf(['flow-a', 'flow-b'], 'flow-a'));
    const refusal = r.select.respondLater();
    const picker = createFlowPicker(r.host, r.deps);

    r.views.fire('/repo-a', neverStarted(['a1']));
    await settle();
    await ensureOpen(r.host);
    const pullsBeforePick = r.catalog.pulls().length;
    option(r.host, 'flow-b').click();
    await settle();
    await ensureOpen(r.host);
    expect(option(r.host, 'flow-b').getAttribute('aria-selected')).toBe('true');
    refusal.resolve({ ok: false, reason: 'Could not save the selection: disk full' });
    await settle();

    expect(r.select.calls()).toEqual([['/repo-a', 'flow-b']]);
    expect(r.host.querySelector('[role="alert"]')?.textContent).toContain('Could not save the selection: disk full');
    expect(r.catalog.pulls()).toHaveLength(pullsBeforePick);
    expect(trigger(r.host).textContent).toBe('Flow: flow-a');
    await ensureOpen(r.host);
    expect(option(r.host, 'flow-a').getAttribute('aria-selected')).toBe('true');
    expect(option(r.host, 'flow-b').getAttribute('aria-selected')).not.toBe('true');
    picker.dispose();
  });

  it('a pick whose write rejects outright announces a reason and restores the prior selection', async () => {
    const r = rig();
    r.catalog.serve('/repo-a', listingOf(['flow-a', 'flow-b'], 'flow-a'));
    const failure = r.select.respondLater();
    const picker = createFlowPicker(r.host, r.deps);

    r.views.fire('/repo-a', neverStarted(['a1']));
    await settle();
    await ensureOpen(r.host);
    option(r.host, 'flow-b').click();
    await settle();
    await ensureOpen(r.host);
    expect(option(r.host, 'flow-b').getAttribute('aria-selected')).toBe('true');
    failure.reject(new Error('ipc channel closed'));
    await settle();

    expect(r.host.querySelector('[role="alert"]')?.textContent?.trim()).toBeTruthy();
    await ensureOpen(r.host);
    expect(option(r.host, 'flow-a').getAttribute('aria-selected')).toBe('true');
    expect(option(r.host, 'flow-b').getAttribute('aria-selected')).not.toBe('true');
    picker.dispose();
  });

  it.each([
    ['refused', (p: ReturnType<ReturnType<typeof rig>['select']['respondLater']>) => p.resolve({ ok: false, reason: 'Could not save the selection: disk full' })],
    ['rejected', (p: ReturnType<ReturnType<typeof rig>['select']['respondLater']>) => p.reject(new Error('ipc channel closed'))],
  ])('a %s first pick with nothing selected before it leaves no flow selected', async (_label, fail) => {
    const r = rig();
    r.catalog.serve('/repo-a', listingOf(['flow-a', 'flow-b']));
    const pending = r.select.respondLater();
    const picker = createFlowPicker(r.host, r.deps);

    r.views.fire('/repo-a', neverStarted(['a1']));
    await settle();
    await ensureOpen(r.host);
    option(r.host, 'flow-b').click();
    await settle();
    await ensureOpen(r.host);
    expect(option(r.host, 'flow-b').getAttribute('aria-selected')).toBe('true');
    fail(pending);
    await settle();

    expect(r.host.querySelector('[role="alert"]')?.textContent?.trim()).toBeTruthy();
    await ensureOpen(r.host);
    expect(r.host.querySelectorAll('[role="option"][aria-selected="true"]')).toHaveLength(0);
    picker.dispose();
  });

  it('a listing failure shows its reason, never an empty list', async () => {
    const r = rig();
    r.catalog.serve('/repo-a', { ok: false, reason: 'Could not list flows: boom' });
    const picker = createFlowPicker(r.host, r.deps);

    r.views.fire('/repo-a', neverStarted(['a1']));
    await settle();
    const btn = findTrigger(r.host);
    if (btn && !btn.disabled) {
      btn.click();
      await settle();
    }

    expect(r.host.textContent).toContain('Could not list flows: boom');
    expect(options(r.host)).toEqual([]);
    expect(findTrigger(r.host)?.getAttribute('aria-expanded') ?? 'false').toBe('false');
    picker.dispose();
  });
});

describe('flow picker — follows the worktree of each view (AC2)', () => {
  it("pulls each view's own worktree listing and shows only that worktree's rows", async () => {
    const r = rig();
    r.catalog.serve('/repo-a', listingOf(['only-in-a', 'shared']));
    r.catalog.serve('/repo-b', listingOf(['only-in-b', 'shared']));
    const picker = createFlowPicker(r.host, r.deps);

    r.views.fire('/repo-a', neverStarted(['a1']));
    await settle();
    r.views.fire('/repo-b', neverStarted(['b1']));
    await settle();
    await ensureOpen(r.host);

    expect(r.catalog.pulls()).toContain('/repo-b');
    expect(r.catalog.pulls().at(-1)).toBe('/repo-b');
    expect(options(r.host).map((o) => o.textContent?.trim())).toEqual(
      expect.arrayContaining([expect.stringContaining('only-in-b'), expect.stringContaining('shared')]),
    );
    expect(options(r.host).some((o) => (o.textContent ?? '').includes('only-in-a'))).toBe(false);
    picker.dispose();
  });

  it('a pick after the view moves to another worktree asks for that worktree, never the first one', async () => {
    const r = rig();
    r.catalog.serve('/repo-a', listingOf(['only-in-a', 'shared']));
    r.catalog.serve('/repo-b', listingOf(['only-in-b', 'shared']));
    r.select.respond({ ok: true });
    const picker = createFlowPicker(r.host, r.deps);

    r.views.fire('/repo-a', neverStarted(['a1']));
    await settle();
    r.views.fire('/repo-b', neverStarted(['b1']));
    await settle();
    await ensureOpen(r.host);
    option(r.host, 'only-in-b').click();
    await settle();

    expect(r.select.calls()).toEqual([['/repo-b', 'only-in-b']]);
    picker.dispose();
  });

  it.each([
    ['refused', (p: ReturnType<ReturnType<typeof rig>['select']['respondLater']>) => p.resolve({ ok: false, reason: 'Could not save the selection: disk full' })],
    ['rejected', (p: ReturnType<ReturnType<typeof rig>['select']['respondLater']>) => p.reject(new Error('ipc channel closed'))],
  ])('a %s pick on the first worktree that fails after the view moved never repaints the new worktree selection', async (_label, fail) => {
    const r = rig();
    r.catalog.serve('/repo-a', listingOf(['flow-a', 'flow-b'], 'flow-a'));
    r.catalog.serve('/repo-b', listingOf(['flow-a', 'flow-b', 'only-in-b'], 'only-in-b'));
    const pending = r.select.respondLater();
    const picker = createFlowPicker(r.host, r.deps);

    r.views.fire('/repo-a', neverStarted(['a1']));
    await settle();
    await ensureOpen(r.host);
    option(r.host, 'flow-b').click();
    await settle();
    r.views.fire('/repo-b', neverStarted(['b1']));
    await settle();
    await ensureOpen(r.host);
    expect(option(r.host, 'only-in-b').getAttribute('aria-selected')).toBe('true');
    fail(pending);
    await settle();

    await ensureOpen(r.host);
    expect(option(r.host, 'only-in-b').getAttribute('aria-selected')).toBe('true');
    expect(option(r.host, 'flow-a').getAttribute('aria-selected')).not.toBe('true');
    picker.dispose();
  });

  it('refresh() re-lists the shown worktree, and while idle it shows nothing', async () => {
    const r = rig();
    r.catalog.serve('/repo-a', listingOf(['flow-a']));
    const picker = createFlowPicker(r.host, r.deps);

    r.views.fire('/repo-a', neverStarted(['a1']));
    await settle();
    await ensureOpen(r.host);
    expect(options(r.host).some((o) => (o.textContent ?? '').includes('flow-b'))).toBe(false);

    r.catalog.serve('/repo-a', listingOf(['flow-a', 'flow-b']));
    picker.refresh();
    await settle();
    await ensureOpen(r.host);
    expect(option(r.host, 'flow-b')).toBeDefined();

    r.views.fire(null, null);
    await settle();
    picker.refresh();
    await settle();
    expect(options(r.host)).toEqual([]);
    expect(findTrigger(r.host)?.disabled ?? true).toBe(true);
    picker.dispose();
  });

  it("a late listing for the previous worktree never repaints the current worktree's rows", async () => {
    const r = rig();
    const lateA = r.catalog.hold('/repo-a');
    r.catalog.serve('/repo-b', listingOf(['only-in-b']));
    const picker = createFlowPicker(r.host, r.deps);

    r.views.fire('/repo-a', neverStarted(['a1']));
    await settle();
    r.views.fire('/repo-b', neverStarted(['b1']));
    await settle();
    lateA.resolve(listingOf(['only-in-a']));
    await settle();
    await ensureOpen(r.host);

    expect(options(r.host).map((o) => (o.textContent ?? '').includes('only-in-b'))).toEqual([true]);
    expect(r.host.textContent).not.toContain('only-in-a');
    picker.dispose();
  });

  it.each([
    ['refused', (d: Deferred<FlowCatalogListResult>) => d.resolve({ ok: false, reason: 'Could not list flows: boom' })],
    ['rejected', (d: Deferred<FlowCatalogListResult>) => d.reject(new Error('Could not list flows: boom'))],
  ])("a %s listing for the next worktree clears the previous worktree's rows and shows a reason", async (_label, fail) => {
    const r = rig();
    r.catalog.serve('/repo-a', listingOf(['only-in-a']));
    r.select.respond({ ok: true });
    const picker = createFlowPicker(r.host, r.deps);

    r.views.fire('/repo-a', neverStarted(['a1']));
    await settle();
    await ensureOpen(r.host);
    option(r.host, 'only-in-a');

    const listingB = r.catalog.hold('/repo-b');
    r.views.fire('/repo-b', neverStarted(['b1']));
    await settle();
    fail(listingB);
    await settle();
    expect(r.host.textContent).not.toContain('only-in-a');
    expect(options(r.host)).toEqual([]);
    await openIfClosed(r.host);

    expect(r.host.textContent).toContain('Could not list flows: boom');
    expect(r.host.textContent).not.toContain('only-in-a');
    expect(options(r.host)).toEqual([]);
    await pickEveryOfferedRow(r.host);
    expect(r.select.calls()).toEqual([]);
    picker.dispose();
  });

  it("while the next worktree's listing is in flight, no previous-worktree row is offered or can be picked", async () => {
    const r = rig();
    r.catalog.serve('/repo-a', listingOf(['only-in-a']));
    r.select.respond({ ok: true });
    const picker = createFlowPicker(r.host, r.deps);

    r.views.fire('/repo-a', neverStarted(['a1']));
    await settle();
    await ensureOpen(r.host);
    option(r.host, 'only-in-a');

    const listingB = r.catalog.hold('/repo-b');
    r.views.fire('/repo-b', neverStarted(['b1']));
    await settle();
    expect(r.host.textContent).not.toContain('only-in-a');
    await openIfClosed(r.host);

    expect(r.host.textContent).not.toContain('only-in-a');
    await pickEveryOfferedRow(r.host);
    expect(r.select.calls()).toEqual([]);

    listingB.resolve(listingOf(['only-in-b']));
    await settle();
    await ensureOpen(r.host);
    expect(option(r.host, 'only-in-b')).toBeDefined();
    picker.dispose();
  });

  it("a late listing from an earlier view of the same worktree never overwrites the newer selection", async () => {
    const r = rig();
    const stale = r.catalog.hold('/repo-a');
    r.catalog.serve('/repo-a', listingOf(['flow-a', 'flow-b'], 'flow-b'));
    const picker = createFlowPicker(r.host, r.deps);

    r.views.fire('/repo-a', neverStarted(['a1']));
    await settle();
    r.views.fire('/repo-a', neverStarted(['b1']));
    await settle();
    stale.resolve(listingOf(['flow-a', 'flow-b'], 'flow-a'));
    await settle();
    await ensureOpen(r.host);

    expect(option(r.host, 'flow-b').getAttribute('aria-selected')).toBe('true');
    expect(option(r.host, 'flow-a').getAttribute('aria-selected')).not.toBe('true');
    picker.dispose();
  });

  it('a listing requested before a pick never overwrites the picked selection when it answers late', async () => {
    const r = rig();
    r.catalog.serve('/repo-a', listingOf(['flow-a', 'flow-b'], 'flow-a'));
    r.select.respond({ ok: true });
    const picker = createFlowPicker(r.host, r.deps);
    r.views.fire('/repo-a', neverStarted(['a1']));
    await settle();

    const beforePick = r.catalog.hold('/repo-a');
    r.views.fire('/repo-a', neverStarted(['a2']));
    await settle();
    await ensureOpen(r.host);
    option(r.host, 'flow-b').click();
    await settle();
    beforePick.resolve(listingOf(['flow-a', 'flow-b'], 'flow-a'));
    await settle();
    await ensureOpen(r.host);

    expect(option(r.host, 'flow-b').getAttribute('aria-selected')).toBe('true');
    expect(option(r.host, 'flow-a').getAttribute('aria-selected')).not.toBe('true');
    picker.dispose();
  });

  it('when the strip goes idle it leaves no row or enabled control, and a late listing does not repaint it', async () => {
    const r = rig();
    r.catalog.serve('/repo-a', listingOf(['only-in-a']));
    const picker = createFlowPicker(r.host, r.deps);

    r.views.fire('/repo-a', neverStarted(['a1']));
    await settle();
    await ensureOpen(r.host);
    option(r.host, 'only-in-a');

    const lateA = r.catalog.hold('/repo-a');
    r.views.fire('/repo-a', neverStarted(['a1']));
    await settle();
    r.views.fire(null, null);
    await settle();
    lateA.resolve(listingOf(['only-in-a']));
    await settle();

    expect(options(r.host)).toEqual([]);
    expect([...r.host.querySelectorAll('button')].filter((b) => !b.disabled)).toEqual([]);
    picker.dispose();
  });
});

describe('the strip-to-picker view feed', () => {
  it('carries a worktree together with its view, or neither when idle', () => {
    const feeds: [Parameters<FlowPickerDeps['onView']>[0], NonNullable<FlowStripDeps['onView']>] = [() => {}, () => {}];
    for (const emit of feeds) {
      emit('/repo-a', neverStarted(['a1']));
      emit(null, null);
      // @ts-expect-error a view with no worktree
      emit(null, neverStarted(['a1']));
      // @ts-expect-error a worktree with no view
      emit('/repo-a', null);
    }
  });
});

describe('flow picker — relocation (UI-STANDARDS §3.3)', () => {
  it('renders from its host document', async () => {
    const r = rig();
    r.catalog.serve('/repo-a', listingOf(['flow-a']));
    await assertRendersFromHostDocument(async (host) => {
      createFlowPicker(host, r.deps);
      r.views.fire('/repo-a', neverStarted(['a1']));
      await settle();
    });
  });

  it('behaves identically in two placements on one fan-out, and a disposed one receives no further view', async () => {
    const views = createFeed<FlowViewArgs>();
    const first = rig(views);
    const second = rig(views);
    for (const r of [first, second]) r.catalog.serve('/repo-a', listingOf(['flow-a', 'flow-b'], 'flow-b'));
    const pickerOne = createFlowPicker(first.host, first.deps);
    const pickerTwo = createFlowPicker(second.host, second.deps);

    views.fire('/repo-a', neverStarted(['a1']));
    await settle();
    for (const r of [first, second]) {
      await ensureOpen(r.host);
      expect(option(r.host, 'flow-b').getAttribute('aria-selected')).toBe('true');
    }

    expect(views.listeners()).toBe(2);
    pickerOne.dispose();
    expect(views.listeners()).toBe(1);
    const disposedPulls = first.catalog.pulls().length;
    views.fire('/repo-a', neverStarted(['a1']));
    await settle();

    expect(first.catalog.pulls()).toHaveLength(disposedPulls);
    expect(first.host.childElementCount).toBe(0);
    await ensureOpen(second.host);
    expect(option(second.host, 'flow-b').getAttribute('aria-selected')).toBe('true');
    pickerTwo.dispose();
    expect(views.listeners()).toBe(0);
  });
});

describe('flow picker — the strip stays the only flow-state puller', () => {
  it('a one-shot notice still reaches the strip with the picker mounted on its fan-out', async () => {
    const views = createFeed<FlowViewArgs>();
    const r = rig(views);
    r.catalog.serve('/repo', listingOf(['flow-a']));
    let answered = 0;
    const state = async (repoKey: string): Promise<FlowStateView> => ({
      ...neverStarted([`${repoKey}-step`]),
      ...(answered++ === 0 ? { notice: 'The shell was busy; the step was handed off.' } : {}),
    });
    const stripHost = document.body.appendChild(document.createElement('div'));
    const strip = createFlowStrip(stripHost, {
      state,
      start: state,
      advance: state,
      restart: state,
      undo: state,
      terminate: state,
      provideInput: state,
      onStateChanged: () => () => {},
      onStatusBar: () => {},
      onView: (...args) => views.fire(...args),
    });
    const picker = createFlowPicker(r.host, r.deps);

    strip.onRepoChanged('/repo');
    await settle();

    expect(stripHost.querySelector('.flow-notice')?.textContent).toContain('The shell was busy');
    await ensureOpen(r.host);
    expect(options(r.host).map((o) => o.textContent)).toEqual([expect.stringContaining('flow-a')]);

    r.catalog.serve('/repo', listingOf(['flow-a', 'flow-b']));
    await strip.refresh();
    await settle();
    await ensureOpen(r.host);
    expect(option(r.host, 'flow-b')).toBeDefined();
    picker.dispose();
    strip.dispose();
  });
});

describe('flow picker — keyboard, focus and announcements (WCAG 2.1.1 / 2.4.3 / 4.1.2 / 4.1.3)', () => {
  const withUnavailable = (): FlowCatalogListResult => {
    const base = listingOf(['flow-a']);
    if (!base.ok) throw new Error('unreachable');
    return {
      ok: true,
      listing: {
        ...base.listing,
        entries: [...base.listing.entries, { available: false, label: 'broken', origin: 'repo', reason: 'it escapes its tier' }],
      },
    };
  };
  const key = (el: Element, k: string): void => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  };
  const active = (): Element | null => document.activeElement;

  it('a view push while an option is focused keeps focus on that option', async () => {
    const r = rig();
    r.catalog.serve('/repo-a', listingOf(['flow-a', 'flow-b']));
    const picker = createFlowPicker(r.host, r.deps);
    r.views.fire('/repo-a', neverStarted(['a1']));
    await settle();
    await ensureOpen(r.host);
    option(r.host, 'flow-b').focus();

    r.catalog.serve('/repo-a', listingOf(['flow-a', 'flow-b', 'flow-c']));
    r.views.fire('/repo-a', neverStarted(['a2']));
    await settle();

    expect(option(r.host, 'flow-c')).toBeDefined();
    expect(active()?.getAttribute('role')).toBe('option');
    expect(active()?.textContent).toContain('flow-b');
    picker.dispose();
  });

  it('a view push whose listing is unchanged leaves the open list in place', async () => {
    const r = rig();
    r.catalog.serve('/repo-a', listingOf(['flow-a', 'flow-b'], 'flow-a'));
    const picker = createFlowPicker(r.host, r.deps);
    r.views.fire('/repo-a', neverStarted(['a1']));
    await settle();
    await ensureOpen(r.host);
    const row = option(r.host, 'flow-b');

    r.views.fire('/repo-a', neverStarted(['a2']));
    await settle();

    expect(option(r.host, 'flow-b')).toBe(row);
    picker.dispose();
  });

  it('keeps one assertive alert region across re-renders, so a failure is not re-announced on every push', async () => {
    const r = rig();
    r.catalog.serve('/repo-a', listingOf(['flow-a', 'flow-b'], 'flow-a'));
    r.select.respond({ ok: false, reason: 'Could not save the selection: disk full' });
    const picker = createFlowPicker(r.host, r.deps);
    r.views.fire('/repo-a', neverStarted(['a1']));
    await settle();
    await ensureOpen(r.host);
    option(r.host, 'flow-b').click();
    await settle();
    const alert = r.host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('disk full');
    const rewrites: MutationRecord[] = [];
    const observer = new MutationObserver((records) => rewrites.push(...records));
    observer.observe(alert!, { childList: true, characterData: true, subtree: true });

    r.catalog.serve('/repo-a', listingOf(['flow-a', 'flow-b', 'flow-c'], 'flow-a'));
    r.views.fire('/repo-a', neverStarted(['a2']));
    await settle();
    rewrites.push(...observer.takeRecords());
    observer.disconnect();

    expect(rewrites, 'an unchanged reason is not rewritten into the live region').toEqual([]);
    expect(r.host.querySelector('[role="alert"]')).toBe(alert);
    expect(alert?.getAttribute('aria-live')).toBe('assertive');
    picker.dispose();
  });

  it('while the listing loads, the trigger does not claim the default flow', async () => {
    const r = rig();
    r.catalog.hold('/repo-a');
    const picker = createFlowPicker(r.host, r.deps);
    r.views.fire('/repo-a', neverStarted(['a1']));
    await settle();

    expect(trigger(r.host).textContent).not.toMatch(/default/i);
    expect(trigger(r.host).textContent).toMatch(/loading/i);
    picker.dispose();
  });

  it('after a listing failure a Retry control, described by the failure, re-lists the worktree', async () => {
    const r = rig();
    r.catalog.serve('/repo-a', { ok: false, reason: 'Could not list flows: boom' });
    const picker = createFlowPicker(r.host, r.deps);
    r.views.fire('/repo-a', neverStarted(['a1']));
    await settle();

    const retry = [...r.host.querySelectorAll('button')].find((b) => /retry/i.test(b.textContent ?? ''));
    expect(retry?.disabled).toBe(false);
    for (const control of [retry!, trigger(r.host)]) {
      expect(document.getElementById(control.getAttribute('aria-describedby') ?? '')?.textContent).toContain('Could not list flows: boom');
    }

    r.catalog.serve('/repo-a', listingOf(['flow-a']));
    retry!.click();
    await settle();
    await ensureOpen(r.host);
    expect(option(r.host, 'flow-a')).toBeDefined();
    picker.dispose();
  });

  it('Retry keeps keyboard focus in the picker: on Retry when the re-list fails again, on the trigger once it lists', async () => {
    const r = rig();
    r.catalog.serve('/repo-a', { ok: false, reason: 'Could not list flows: boom' });
    const picker = createFlowPicker(r.host, r.deps);
    r.views.fire('/repo-a', neverStarted(['a1']));
    await settle();
    const retry = (): HTMLButtonElement | undefined =>
      [...r.host.querySelectorAll('button')].find((b) => /retry/i.test(b.textContent ?? ''));

    const relisting = r.catalog.hold('/repo-a');
    retry()!.focus();
    retry()!.click();
    await settle();
    expect(r.host.contains(active()), 'focus stays inside the picker while it re-lists').toBe(true);

    relisting.resolve({ ok: false, reason: 'Could not list flows: again' });
    await settle();
    expect(active()).toBe(retry());

    r.catalog.serve('/repo-a', listingOf(['flow-a']));
    retry()!.click();
    await settle();
    expect(active()).toBe(trigger(r.host));
    picker.dispose();
  });

  it("an unavailable entry's accessible name is its label and tier, its reason only its description", async () => {
    const r = rig();
    r.catalog.serve('/repo-a', withUnavailable());
    const picker = createFlowPicker(r.host, r.deps);
    r.views.fire('/repo-a', neverStarted(['a1']));
    await settle();
    await ensureOpen(r.host);
    const broken = option(r.host, 'broken');
    const refText = (attr: string): string =>
      (broken.getAttribute(attr) ?? '')
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ');
    // WAI-ARIA accname 1.2 §4.3.2 step 2B
    const name = broken.hasAttribute('aria-labelledby') ? refText('aria-labelledby') : (broken.textContent ?? '');

    expect(name).toContain('broken');
    expect(name).toMatch(/repo/i);
    expect(name).not.toContain('it escapes its tier');
    expect(refText('aria-describedby')).toContain('it escapes its tier');
    picker.dispose();
  });

  it('arrow keys reach an unavailable entry, which exposes its reason and cannot be picked', async () => {
    const r = rig();
    r.catalog.serve('/repo-a', withUnavailable());
    r.select.respond({ ok: true });
    const picker = createFlowPicker(r.host, r.deps);
    r.views.fire('/repo-a', neverStarted(['a1']));
    await settle();
    await ensureOpen(r.host);
    expect(active()?.textContent).toContain('flow-a');

    key(active()!, 'ArrowDown');
    const broken = active() as HTMLElement;
    expect(broken.textContent).toContain('broken');
    expect(broken.getAttribute('aria-disabled')).toBe('true');
    expect(document.getElementById(broken.getAttribute('aria-describedby') ?? '')?.textContent).toContain('it escapes its tier');

    key(broken, 'Enter');
    key(broken, ' ');
    broken.click();
    await settle();
    expect(r.select.calls()).toEqual([]);
    picker.dispose();
  });

  it('Enter on an option reached by ArrowDown picks it and returns focus to the trigger', async () => {
    const r = rig();
    r.catalog.serve('/repo-a', listingOf(['flow-a', 'flow-b']));
    r.select.respond({ ok: true });
    const picker = createFlowPicker(r.host, r.deps);
    r.views.fire('/repo-a', neverStarted(['a1']));
    await settle();
    await ensureOpen(r.host);

    key(active()!, 'ArrowDown');
    expect(active()?.textContent).toContain('flow-b');
    key(active()!, 'Enter');
    await settle();

    expect(r.select.calls()).toEqual([['/repo-a', 'flow-b']]);
    expect(active()).toBe(trigger(r.host));
    picker.dispose();
  });

  it('Escape, a mousedown outside, and focus leaving the picker each close the list', async () => {
    const r = rig();
    r.catalog.serve('/repo-a', listingOf(['flow-a']));
    const outside = document.body.appendChild(document.createElement('button'));
    const picker = createFlowPicker(r.host, r.deps);
    r.views.fire('/repo-a', neverStarted(['a1']));
    await settle();

    await ensureOpen(r.host);
    key(active()!, 'Escape');
    expect(options(r.host)).toEqual([]);
    expect(trigger(r.host).getAttribute('aria-expanded')).toBe('false');
    expect(active()).toBe(trigger(r.host));

    await ensureOpen(r.host);
    outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(options(r.host)).toEqual([]);

    await ensureOpen(r.host);
    active()!.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: outside }));
    expect(options(r.host)).toEqual([]);
    expect(trigger(r.host).getAttribute('aria-expanded')).toBe('false');
    picker.dispose();
  });

  it('the open trigger names the listbox it controls, uniquely per picker', async () => {
    const views = createFeed<FlowViewArgs>();
    const first = rig(views);
    const second = rig(views);
    for (const r of [first, second]) r.catalog.serve('/repo-a', listingOf(['flow-a']));
    const pickers = [createFlowPicker(first.host, first.deps), createFlowPicker(second.host, second.deps)];
    views.fire('/repo-a', neverStarted(['a1']));
    await settle();

    const ids = [];
    for (const r of [first, second]) {
      await ensureOpen(r.host);
      expect(trigger(r.host).getAttribute('aria-expanded')).toBe('true');
      const controls = trigger(r.host).getAttribute('aria-controls') ?? '';
      expect(r.host.querySelector('[role="listbox"]')?.id).toBe(controls);
      ids.push(controls);
    }
    expect(new Set(ids).size).toBe(2);
    for (const p of pickers) p.dispose();
  });

  it('a rejected write echoes a display-sanitized, length-bounded reason (§18.7.6)', async () => {
    const r = rig();
    r.catalog.serve('/repo-a', listingOf(['flow-a']));
    const failure = r.select.respondLater();
    const picker = createFlowPicker(r.host, r.deps);
    r.views.fire('/repo-a', neverStarted(['a1']));
    await settle();
    await ensureOpen(r.host);
    option(r.host, 'flow-a').click();
    failure.reject(new Error(`bad\u202Ename\u200B${'x'.repeat(500)}`));
    await settle();

    const text = r.host.querySelector('[role="alert"]')?.textContent ?? '';
    expect(text).toMatch(/bad\s*name/);
    expect(text).not.toMatch(/[\u202E\u200B]/u);
    expect(text.length).toBeLessThanOrEqual(MAX_ECHOED_REASON_LENGTH);
    picker.dispose();
  });
});

describe('flow picker placement in the layout (§22.4)', () => {
  it('declares the picker host in the rail beside the strip, outside the strip’s live status region', () => {
    const html = readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf8');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const strip = doc.getElementById('flow-strip');
    const host = doc.getElementById('flow-picker');

    expect(host, 'index.html declares #flow-picker').not.toBeNull();
    expect(host?.classList.contains('flowpicker')).toBe(true);
    expect(host?.closest('.rail')).not.toBeNull();
    expect(strip?.nextElementSibling).toBe(host);
    expect(strip?.contains(host)).toBe(false);
  });
});
