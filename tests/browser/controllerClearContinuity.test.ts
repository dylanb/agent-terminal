import { afterEach, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { ControllerTerminal, ControllerClearOutcome, ControllerClearTarget } from '../../src/shared/ipc';
import { mountControllerPanes } from '../helpers/controllerMount';
import { statusService, statusTerminal, withActivity } from '../helpers/controllerStatusFixture';
import { cardIn, cardHeaderIn, clearHistoryIn, historyIn, timelineEntriesIn } from '../helpers/controllerCards';
import { notificationItem, statusItem } from '../helpers/controllerHistory';
import '../helpers/rendererTokens';
import '../../src/renderer/src/styles.css';

const directory = '/fixed/worktree';
const entries = [notificationItem('Newest original', 2000), statusItem('Earlier distinct', 1000)];
const initial = (): ControllerTerminal => ({ ...statusTerminal({ activity: 'quiet', attention: { status: 'complete', reasons: ['Pending approval'] } }), timeline: entries, clearHistoryTarget: { id: 'history-target', launchDirectory: directory, revision: 'initial' } });
const arrival = (before: ControllerTerminal): ControllerTerminal => {
  const newest = notificationItem('New protected arrival', 3000);
  return { ...before, timeline: [newest, ...entries], clearHistoryTarget: { ...before.clearHistoryTarget!, revision: 'arrival' } };
};
const painted = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
afterEach(() => { document.body.replaceChildren(); document.documentElement.removeAttribute('data-theme'); });

for (const theme of ['light', 'dark'] as const) for (const placement of ['body', 'nested']) {
  function mount(clear?: (observed: ControllerClearTarget) => Promise<ControllerClearOutcome>) {
    document.documentElement.dataset.theme = theme;
    const parent = document.createElement('section'); parent.style.width = '320px'; document.body.append(parent);
    const before = initial(); const service = statusService([before], { theme });
    const api = { ...service.api, clearHistory: clear ?? service.api.clearHistory };
    const mounted = mountControllerPanes({ parent: placement === 'nested' ? parent : document.body, controller: api, oneColumn: true });
    mounted.host.style.width = '320px';
    return { ...mounted, service, before, card: () => cardIn(mounted.host, directory)! };
  }
  it(`${theme}/${placement}: pending Clear protects rebuilt card controls until its reply`, async () => {
    let release!: () => void;
    const h = mount(async () => {
      await new Promise<void>(resolve => { release = resolve; });
      return 'stale';
    });
    try {
      clearHistoryIn(h.card())?.click();
      h.service.publish([arrival(h.before)]);
      await painted();
      expect.soft(clearHistoryIn(h.card())?.getAttribute('aria-disabled')).toBe('true');
      expect.soft(clearHistoryIn(h.card())?.getAttribute('aria-busy')).toBe('true');
      expect.soft(timelineEntriesIn(h.card())).toHaveLength(3);
      release?.(); await painted();
      expect.soft(clearHistoryIn(h.card())?.getAttribute('aria-disabled')).not.toBe('true');
    } finally { release?.(); h.dispose(); }
  });
  for (const update of ['status', 'arrival'] as const) {
    it(`${theme}/${placement}: the entries and Clear focus survive ${update}`, async () => {
      const h = mount();
      try {
        clearHistoryIn(h.card())?.focus();
        h.service.publish([update === 'arrival' ? arrival(h.before) : { ...h.before, work: withActivity(h.before.work!, 'quiet') }]);
        await painted();
        expect.soft(h.card().innerText).toContain('Earlier distinct');
        expect.soft(historyIn(h.card())).toBeUndefined();
        expect.soft(document.activeElement).toBe(clearHistoryIn(h.card()));
        expect.soft(h.service.activated).toEqual([]);
      } finally { h.dispose(); }
    });
  }
  it(`${theme}/${placement}: Clear removal and conflict removal use the card fallback without stealing outside focus`, async () => {
    const h = mount(async () => { h.service.publish([{ ...h.before, timeline: [] }]); return 'cleared'; });
    try {
      clearHistoryIn(h.card())?.focus(); await userEvent.keyboard('{Enter}'); await painted();
      expect.soft(document.activeElement).toBe(cardHeaderIn(h.card(), directory));
      expect.soft(timelineEntriesIn(h.card())).toEqual([]);
      h.service.publish([h.before]); await painted(); clearHistoryIn(h.card())?.focus();
      h.service.publish([h.before, { ...h.before, id: 'overlap' }]); await painted();
      expect.soft(clearHistoryIn(h.card())).toBeUndefined();
      expect.soft(document.activeElement).toBe(cardHeaderIn(h.card(), directory));
      const outside = document.createElement('button'); outside.textContent = 'Outside'; document.body.append(outside); outside.focus();
      h.service.publish([arrival(h.before)]); await painted();
      expect.soft(document.activeElement).toBe(outside);
      cardHeaderIn(h.card(), directory)!.click();
      h.service.publish([arrival(h.before)]); await painted();
      expect.soft(cardHeaderIn(h.card(), directory)!.getAttribute('aria-expanded')).toBe('false');
      expect.soft(h.service.activated).toEqual([]);
    } finally { h.dispose(); }
  });
  it(`${theme}/${placement}: an older successful Clear reply cannot hide a later arrival`, async () => {
    let release!: () => void;
    const h = mount(async observed => {
      h.service.publish([{ ...h.before, timeline: [] }]);
      if (observed.revision !== 'arrival') {
        await new Promise<void>(resolve => { release = resolve; });
      }
      return 'cleared';
    });
    try {
      clearHistoryIn(h.card())?.click();
      await painted();
      expect(timelineEntriesIn(h.card())).toEqual([]);
      const newest = arrival(h.before).timeline![0];
      h.service.publish([{ ...arrival(h.before), timeline: [newest] }]);
      release?.(); await painted();
      expect.soft(timelineEntriesIn(h.card())[0]?.innerText).toContain('New protected arrival');
      expect.soft(timelineEntriesIn(h.card())).toHaveLength(1);
      clearHistoryIn(h.card())?.click(); await painted();
      expect.soft(timelineEntriesIn(h.card())).toEqual([]);
      expect.soft(h.service.activated).toEqual([]);
    } finally { h.dispose(); }
  });
  for (const result of ['stale', 'unavailable', 'rejected'] as const) {
    it(`${theme}/${placement}: ${result} Clear visibly refuses and supports explicit retry`, async () => {
      let release!: () => void;
      let requested!: ControllerClearTarget;
      let received!: () => void;
      const dispatched = new Promise<void>(resolve => { received = resolve; });
      const h = mount(async observed => {
        requested = observed; received();
        if (observed.revision === 'arrival') {
          h.service.publish([{ ...arrival(h.before), timeline: [] }]);
          return 'cleared';
        }
        await new Promise<void>(resolve => { release = resolve; });
        if (result === 'rejected') throw new Error('Clear transport unavailable');
        return result;
      });
      try {
        clearHistoryIn(h.card())?.click();
        await Promise.race([dispatched, painted()]);
        expect(requested).toEqual(h.before.clearHistoryTarget);
        h.service.publish([arrival(h.before)]);
        release?.(); await painted();
        const feedback = [...h.host.querySelectorAll<HTMLElement>('[role="alert"], [role="status"]')]
          .map(node => node.innerText).join(' ');
        expect.soft(feedback).toMatch(/stale|changed|unavailable|retry|could not|unable/i);
        expect.soft(timelineEntriesIn(h.card())[0]?.innerText).toContain('New protected arrival');
        expect.soft(h.service.activated).toEqual([]);
        clearHistoryIn(h.card())?.click(); await painted();
        expect.soft(requested).toEqual(arrival(h.before).clearHistoryTarget);
        expect.soft(timelineEntriesIn(h.card())).toEqual([]);
      } finally { h.dispose(); }
    });
  }
}
