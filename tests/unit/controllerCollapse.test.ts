// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { bringForwardIn, cardHeaderIn, cardIn, cardsIn, headerLabels, statusRowIn, unshownCounts, windowHeaderIn } from '../helpers/controllerCards';
import { mountControllerPanes } from '../helpers/controllerMount';
import { STATUS_CASES, statusTerminal, type StatusCase } from '../helpers/controllerStatusFixture';

afterEach(() => document.body.replaceChildren());

const EXPANDED_IN_ONE_COLUMN = new Set(['error', 'needs-human']);
const cases = Object.entries(STATUS_CASES);

/** The card header control for `directory` in `host`, or `undefined` when its card or its header is missing. */
function header(host: HTMLElement, directory: string): HTMLElement | undefined {
  const card = cardIn(host, directory);
  return card ? cardHeaderIn(card, directory) : undefined;
}

/** `true` or `false` for the header's `aria-expanded`, or a description of what is missing, so a check never throws. */
function expanded(host: HTMLElement, directory: string): boolean | string {
  const control = header(host, directory);
  if (!control) return `no header for ${directory}`;
  const state = control.getAttribute('aria-expanded');
  return state === 'true' || state === 'false' ? state === 'true' : `aria-expanded is ${state}`;
}

const working = { ...statusTerminal(), id: 'working', launchDirectory: '/cards/working' };
const blocked = { ...statusTerminal({ attention: { status: 'needs a human', reasons: ['Approve the plan'] }, activity: 'quiet' }), id: 'working', launchDirectory: '/cards/working' };
const peer = { ...statusTerminal({ activity: 'quiet' }), id: 'peer', launchDirectory: '/cards/peer' };

describe('the default collapse rule', () => {
  it('expands error and needs-human cards and collapses idle, working and completed cards in one column, each collapsed header showing its status', () => {
    const { host, dispose } = mountControllerPanes({ terminals: cases.map(([, c]) => c.terminal), oneColumn: true });
    try {
      const state = (c: StatusCase) => ({ expanded: expanded(host, c.terminal.launchDirectory), label: header(host, c.terminal.launchDirectory)?.textContent?.includes(c.text) ?? false });
      expect(Object.fromEntries(cases.map(([key, c]) => [key, state(c)]))).toEqual(Object.fromEntries(cases.map(([key, c]) => [key,
        EXPANDED_IN_ONE_COLUMN.has(c.statusClass) ? { expanded: true, label: expect.any(Boolean) } : { expanded: false, label: true }])));
    } finally { dispose(); }
  });

  it('expands every card in a multi-column layout', () => {
    const { host, dispose } = mountControllerPanes({ terminals: cases.map(([, c]) => c.terminal), oneColumn: false });
    try {
      expect(Object.fromEntries(cases.map(([key, c]) => [key, expanded(host, c.terminal.launchDirectory)])))
        .toEqual(Object.fromEntries(cases.map(([key]) => [key, true])));
    } finally { dispose(); }
  });
});

describe('an untoggled card follows the rule', () => {
  it('expands a collapsed Working card when its terminal starts needing a human', () => {
    const { host, service, dispose } = mountControllerPanes({ terminals: [working], oneColumn: true });
    try {
      const before = expanded(host, working.launchDirectory);
      service.publish([blocked]);
      expect({ before, after: expanded(host, working.launchDirectory) }).toEqual({ before: false, after: true });
    } finally { dispose(); }
  });

  it('expands every card when the window widens to multi-column, and collapses them again when it narrows', () => {
    const { host, layout, dispose } = mountControllerPanes({ terminals: [working, peer], oneColumn: true });
    try {
      const read = () => [expanded(host, working.launchDirectory), expanded(host, peer.launchDirectory)];
      const narrow = read();
      layout.set(false);
      const wide = read();
      layout.set(true);
      expect({ narrow, wide, narrowAgain: read() }).toEqual({ narrow: [false, false], wide: [true, true], narrowAgain: [false, false] });
    } finally { dispose(); }
  });

  it('moves focus from the body to the header when a status change collapses the card', () => {
    const { host, service, dispose } = mountControllerPanes({ terminals: [blocked], oneColumn: true });
    try {
      const card = cardIn(host, blocked.launchDirectory);
      (card && bringForwardIn(card))?.focus();
      service.publish([working]);
      const target = header(host, working.launchDirectory);
      expect({ collapsed: expanded(host, working.launchDirectory) === false, focused: target !== undefined && document.activeElement === target })
        .toEqual({ collapsed: true, focused: true });
    } finally { dispose(); }
  });

  it('moves focus from the body to the header when narrowing the window collapses the card', () => {
    const { host, layout, dispose } = mountControllerPanes({ terminals: [working], oneColumn: false });
    try {
      const card = cardIn(host, working.launchDirectory);
      (card && bringForwardIn(card))?.focus();
      layout.set(true);
      const target = header(host, working.launchDirectory);
      expect({ collapsed: expanded(host, working.launchDirectory) === false, focused: target !== undefined && document.activeElement === target })
        .toEqual({ collapsed: true, focused: true });
    } finally { dispose(); }
  });

  it('leaves focus where it is when narrowing the window collapses a card that does not hold it', () => {
    const { host, layout, dispose } = mountControllerPanes({ terminals: [{ ...blocked, id: 'blocked', launchDirectory: '/cards/blocked' }, peer], oneColumn: false });
    try {
      const card = cardIn(host, '/cards/blocked');
      const bringForward = card ? bringForwardIn(card) : undefined;
      bringForward?.focus();
      layout.set(true);
      const kept = cardIn(host, '/cards/blocked');
      expect({ collapsed: expanded(host, peer.launchDirectory) === false, focused: Boolean(kept) && document.activeElement === (kept && bringForwardIn(kept)) })
        .toEqual({ collapsed: true, focused: true });
    } finally { dispose(); }
  });
});

describe('an activity change alone', () => {
  it('changes an untoggled one-column card\'s written status, open state and the summary counts in the same update, keeping its place', () => {
    const gated = (row: StatusCase) => ({ ...row.terminal, id: 'gated', launchDirectory: '/cards/gated', repositoryRoot: '/cards' });
    const [busy, quiet] = [STATUS_CASES['needs-human-working'], STATUS_CASES['needs-human']];
    const { host, service, dispose } = mountControllerPanes({ terminals: [peer, gated(busy)], oneColumn: true });
    try {
      const read = (row: StatusCase) => {
        const card = cardIn(host, '/cards/gated');
        return {
          status: card ? statusRowIn(card)?.textContent?.trim() : 'no card',
          expanded: expanded(host, '/cards/gated'),
          order: [peer.launchDirectory, '/cards/gated'].map(directory => cardsIn(host).findIndex(c => c === cardIn(host, directory))),
          countsNotShown: unshownCounts(windowHeaderIn(host)?.textContent ?? '', headerLabels(label => [STATUS_CASES.idle.summary, row.summary].filter(summary => summary === label).length, 2, 2)),
        };
      };
      const whileWorking = read(busy);
      service.publish([peer, gated(quiet)]);
      const onceIdle = read(quiet);
      service.publish([peer, gated(busy)]);
      const workingAgain = read(busy);
      const shown = (c: StatusCase, open: boolean) => ({ status: c.text, expanded: open, order: [0, 1], countsNotShown: [] });
      expect({ whileWorking, onceIdle, workingAgain })
        .toEqual({ whileWorking: shown(busy, false), onceIdle: shown(quiet, true), workingAgain: shown(busy, false) });
    } finally { dispose(); }
  });
});

describe('a toggled card keeps the operator\'s choice', () => {
  it('keeps a collapsed needs-human card collapsed through a wider layout, an error and disconnection', () => {
    const { host, service, layout, dispose } = mountControllerPanes({ terminals: [blocked], oneColumn: true });
    try {
      header(host, blocked.launchDirectory)?.click();
      const toggled = expanded(host, blocked.launchDirectory);
      layout.set(false);
      const wide = expanded(host, blocked.launchDirectory);
      service.publish([{ ...blocked, work: { ...blocked.work, error: { reason: 'Step exited 1' } } }]);
      const errored = expanded(host, blocked.launchDirectory);
      service.publish([{ ...blocked, status: 'disconnected' }]);
      expect({ toggled, wide, errored, disconnected: expanded(host, blocked.launchDirectory) })
        .toEqual({ toggled: false, wide: false, errored: false, disconnected: false });
    } finally { dispose(); }
  });

  it('keeps an expanded Working card expanded through completion and a narrow-wide-narrow layout', () => {
    const { host, service, layout, dispose } = mountControllerPanes({ terminals: [working], oneColumn: true });
    try {
      header(host, working.launchDirectory)?.click();
      const toggled = expanded(host, working.launchDirectory);
      service.publish([{ ...statusTerminal({ flow: { availability: 'known', name: 'feature-dev', step: 'implement', assignment: 'completed' } }), id: working.id, launchDirectory: working.launchDirectory }]);
      const completed = expanded(host, working.launchDirectory);
      layout.set(false);
      const wide = expanded(host, working.launchDirectory);
      layout.set(true);
      expect({ toggled, completed, wide, narrowAgain: expanded(host, working.launchDirectory) })
        .toEqual({ toggled: true, completed: true, wide: true, narrowAgain: true });
    } finally { dispose(); }
  });

  it('treats a terminal that registers again under a new id as untoggled', () => {
    const { host, service, dispose } = mountControllerPanes({ terminals: [working], oneColumn: false });
    try {
      header(host, working.launchDirectory)?.click();
      const toggled = expanded(host, working.launchDirectory);
      service.publish([{ ...working, id: 'working-again' }]);
      expect({ toggled, registeredAgain: expanded(host, working.launchDirectory) }).toEqual({ toggled: false, registeredAgain: true });
    } finally { dispose(); }
  });
});

describe('collapsing and bringing forward are independent', () => {
  it('never brings a terminal forward when its header toggles, and never toggles a card when it is brought forward', () => {
    const { host, service, dispose } = mountControllerPanes({ terminals: [working], oneColumn: true });
    try {
      const control = header(host, working.launchDirectory);
      control?.click();
      control?.click();
      control?.click();
      const afterToggles = { activated: [...service.activated], expanded: expanded(host, working.launchDirectory) };
      const card = cardIn(host, working.launchDirectory);
      (card && bringForwardIn(card))?.click();
      expect({ header: Boolean(control), afterToggles, afterBringForward: expanded(host, working.launchDirectory), activated: service.activated })
        .toEqual({ header: true, afterToggles: { activated: [], expanded: true }, afterBringForward: true, activated: [working.id] });
    } finally { dispose(); }
  });
});

describe('focus on a card header across a live update', () => {
  it('stays on the same terminal\'s header when the update keeps its card', () => {
    const { host, service, dispose } = mountControllerPanes({ terminals: [peer, working] });
    try {
      header(host, working.launchDirectory)?.focus();
      service.publish([peer, { ...working, work: { ...working.work, activity: 'quiet' } }]);
      const target = header(host, working.launchDirectory);
      expect(target !== undefined && document.activeElement === target).toBe(true);
    } finally { dispose(); }
  });

  it('moves to the first remaining card\'s header when the update removes the focused card', () => {
    const { host, service, dispose } = mountControllerPanes({ terminals: [working, peer] });
    try {
      header(host, working.launchDirectory)?.focus();
      const focusedBefore = document.activeElement === header(host, working.launchDirectory);
      service.publish([peer]);
      const target = header(host, peer.launchDirectory);
      expect({ focusedBefore, moved: target !== undefined && document.activeElement === target }).toEqual({ focusedBefore: true, moved: true });
    } finally { dispose(); }
  });
});
