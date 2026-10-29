import { afterEach, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { ControllerTerminal, ControllerClearOutcome, ControllerClearTarget } from '../../src/shared/ipc';
import { mountControllerPanes } from '../helpers/controllerMount';
import { statusService, statusTerminal } from '../helpers/controllerStatusFixture';
import { cardIn, cardHeaderIn, clearHistoryIn, historyIn, receivedNotificationIn } from '../helpers/controllerCards';
import '../helpers/rendererTokens';
import '../../src/renderer/src/styles.css';

const directory = '/fixed/worktree';
const entries = [{ message: 'Newest original', receivedAt: 2000, count: 1 }, { message: 'Earlier distinct', receivedAt: 1000, count: 2 }];
const initial = (): ControllerTerminal => ({ ...statusTerminal({ activity: 'quiet', attention: { status: 'complete', reasons: ['Pending approval'] } }), notifications: entries, clearHistoryTarget: { id: 'history-target', launchDirectory: directory, revision: 'initial' } });
const arrival = (before: ControllerTerminal): ControllerTerminal => {
  const newest = { message: 'New protected arrival', receivedAt: 3000, count: 1 };
  return { ...before, notifications: [newest, ...entries], clearHistoryTarget: { ...before.clearHistoryTarget!, revision: 'arrival' } };
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
      historyIn(h.card())!.click();
      clearHistoryIn(h.card())!.click();
      h.service.publish([arrival(h.before)]);
      await painted();
      expect.soft(clearHistoryIn(h.card())!.getAttribute('aria-disabled')).toBe('true');
      expect.soft(clearHistoryIn(h.card())!.getAttribute('aria-busy')).toBe('true');
      historyIn(h.card())!.click();
      expect.soft(historyIn(h.card())!.getAttribute('aria-expanded')).toBe('true');
      release(); await painted();
      expect.soft(clearHistoryIn(h.card())!.getAttribute('aria-disabled')).not.toBe('true');
      historyIn(h.card())!.click();
      expect.soft(historyIn(h.card())!.getAttribute('aria-expanded')).toBe('false');
    } finally { release?.(); h.dispose(); }
  });
  for (const focused of ['history', 'clear'] as const) for (const update of ['status', 'arrival'] as const) {
    it(`${theme}/${placement}: open history and ${focused} focus survive ${update}`, async () => {
      const h = mount();
      try {
        historyIn(h.card())!.click(); await painted();
        (focused === 'history' ? historyIn(h.card())! : clearHistoryIn(h.card())!).focus();
        h.service.publish([update === 'arrival' ? arrival(h.before) : { ...h.before, work: { ...h.before.work!, activity: 'quiet' } }]);
        await painted();
        expect.soft(historyIn(h.card())!.getAttribute('aria-expanded')).toBe('true');
        expect.soft(h.card().innerText).toContain('Earlier distinct');
        expect.soft(document.activeElement).toBe(focused === 'history' ? historyIn(h.card()) : clearHistoryIn(h.card()));
        expect.soft(h.service.activated).toEqual([]);
      } finally { h.dispose(); }
    });
  }
  it(`${theme}/${placement}: Clear removal and conflict removal use the card fallback without stealing outside focus`, async () => {
    const h = mount(async () => { h.service.publish([{ ...h.before, notifications: [] }]); return 'cleared'; });
    try {
      historyIn(h.card())!.click(); clearHistoryIn(h.card())!.focus(); await userEvent.keyboard('{Enter}'); await painted();
      expect.soft(document.activeElement).toBe(cardHeaderIn(h.card(), directory));
      expect.soft(receivedNotificationIn(h.card())).toBeUndefined();
      h.service.publish([h.before]); historyIn(h.card())!.focus();
      h.service.publish([h.before, { ...h.before, id: 'overlap' }]); await painted();
      expect.soft(historyIn(h.card())).toBeUndefined();
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
      h.service.publish([{ ...h.before, notifications: [] }]);
      if (observed.revision !== 'arrival') {
        await new Promise<void>(resolve => { release = resolve; });
      }
      return 'cleared';
    });
    try {
      historyIn(h.card())!.click(); clearHistoryIn(h.card())!.click();
      await painted();
      expect(receivedNotificationIn(h.card())).toBeUndefined();
      const newest = arrival(h.before).notifications![0];
      h.service.publish([{ ...arrival(h.before), notifications: [newest] }]);
      release(); await painted();
      expect.soft(receivedNotificationIn(h.card())?.innerText).toContain('New protected arrival');
      expect.soft(historyIn(h.card())?.textContent).toMatch(/History\s+1\s*\/\s*3/);
      if (historyIn(h.card())!.getAttribute('aria-expanded') !== 'true') historyIn(h.card())!.click();
      clearHistoryIn(h.card())!.click(); await painted();
      expect.soft(receivedNotificationIn(h.card())).toBeUndefined();
      expect.soft(historyIn(h.card())?.textContent).toMatch(/History\s+0\s*\/\s*3/);
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
          h.service.publish([{ ...arrival(h.before), notifications: [] }]);
          return 'cleared';
        }
        await new Promise<void>(resolve => { release = resolve; });
        if (result === 'rejected') throw new Error('Clear transport unavailable');
        return result;
      });
      try {
        historyIn(h.card())!.click(); clearHistoryIn(h.card())!.click();
        await dispatched;
        expect(requested).toEqual(h.before.clearHistoryTarget);
        h.service.publish([arrival(h.before)]);
        release(); await painted();
        const feedback = [...h.host.querySelectorAll<HTMLElement>('[role="alert"], [role="status"]')]
          .map(node => node.innerText).join(' ');
        expect.soft(feedback).toMatch(/stale|changed|unavailable|retry|could not|unable/i);
        expect.soft(receivedNotificationIn(h.card())!.innerText).toContain('New protected arrival');
        expect.soft(h.service.activated).toEqual([]);
        if (historyIn(h.card())!.getAttribute('aria-expanded') !== 'true') historyIn(h.card())!.click();
        clearHistoryIn(h.card())!.click(); await painted();
        expect.soft(requested).toEqual(arrival(h.before).clearHistoryTarget);
        expect.soft(receivedNotificationIn(h.card())).toBeUndefined();
      } finally { h.dispose(); }
    });
  }
}
