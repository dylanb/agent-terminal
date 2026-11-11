import { afterEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import '../../src/renderer/src/styles.css';
import type { ControllerTerminal } from '../../src/shared/ipc';
import { bodyActivationIn, cardsIn, cardHeaderTextIn, cardIn, dismissIn, headerActivationIn, statusRowIn, windowHeaderIn } from '../helpers/controllerCards';
import { mountControllerPanes } from '../helpers/controllerMount';
import { directoryConflictFixture, STATUS_CASES, statusService, statusTerminal } from '../helpers/controllerStatusFixture';

async function tabTo(target: HTMLElement | undefined): Promise<boolean> {
  for (let presses = 0; target && document.activeElement !== target && presses < 60; presses += 1) await userEvent.tab();
  return Boolean(target) && document.activeElement === target;
}

const terminals: ControllerTerminal[] = [
  { id: 'a', launchDirectory: '/l/a', repositoryRoot: '/l' },
  { id: 'b', launchDirectory: '/r/b', repositoryRoot: '/r' },
];

afterEach(() => {
  document.body.replaceChildren();
});

const control = (host: HTMLElement, directory: string, find: (card: HTMLElement) => HTMLElement | undefined) => {
  const card = cardIn(host, directory);
  return card ? find(card) : undefined;
};

describe('controller panes', () => {
  function mount(items: ControllerTerminal[] = terminals) {
    const { host, service, dispose } = mountControllerPanes({ terminals: items });
    return { host, activated: service.activated, component: { dispose } };
  }

  it('shows a disconnected terminal as Disconnected', () => {
    const disconnected = { ...terminals[0], status: 'disconnected' as const };
    const { host, component } = mount([disconnected, terminals[1]]);
    try {
      const card = cardIn(host, disconnected.launchDirectory);
      expect(card ? statusRowIn(card)?.textContent?.trim() : undefined).toBe('Disconnected');
    } finally { component.dispose(); }
  });

  it('moves keyboard focus to the dismiss control', async () => {
    const { host, component } = mount([{ ...terminals[0], status: 'disconnected' }]);
    try {
      expect(await tabTo(control(host, terminals[0].launchDirectory, dismissIn))).toBe(true);
    } finally { component.dispose(); }
  });

  it('brings a terminal forward through native keyboard interaction on the header icon', async () => {
    const { host, activated, component } = mount();
    try {
      const reached = await tabTo(control(host, terminals[0].launchDirectory, headerActivationIn));
      expect(reached).toBe(true);
      await userEvent.keyboard('{Enter}');
      expect(activated).toEqual(['a']);
    } finally { component.dispose(); }
  });

  it('offers the header icon and no body button on every connected card', () => {
    const { host, component } = mount();
    try {
      expect(terminals.map(item => {
        const card = cardIn(host, item.launchDirectory);
        return { icon: Boolean(card && headerActivationIn(card)), body: Boolean(card && bodyActivationIn(card)) };
      })).toEqual(terminals.map(() => ({ icon: true, body: false })));
    } finally { component.dispose(); }
  });
});

describe('the header icon of a duplicate-directory card', () => {
  const { members } = directoryConflictFixture();
  const iconOf = (host: HTMLElement) => { const card = cardsIn(host)[0]; return card ? headerActivationIn(card) : undefined; };

  it('activates every captured member through native keyboard interaction', async () => {
    const { host, service, dispose } = mountControllerPanes({ terminals: members });
    try {
      expect(await tabTo(iconOf(host))).toBe(true);
      await userEvent.keyboard('{Enter}');
      await expect.poll(() => [...service.activated].sort()).toEqual(members.map(member => member.id).sort());
    } finally { dispose(); }
  });

  it('shows Terminal unavailable with the failed and original member counts when some members cannot be reached', async () => {
    const service = statusService(members, { activation: async id => (id === members[0].id ? 'unavailable' : 'activated') });
    const { host, dispose } = mountControllerPanes({ controller: service.api });
    try {
      const icon = iconOf(host);
      expect(icon, 'header icon').toBeDefined();
      if (icon) await userEvent.click(icon);
      await expect.poll(() => host.querySelector('[role="alert"]')?.textContent ?? '').toMatch(/Terminal unavailable[\s\S]*1 (?:of|out of) 3/i);
    } finally { dispose(); }
  });
});

describe.each(['aside', 'main'])('the controller organism placed in %s', tag => {
  it('shows the same header counts and status text', () => {
    const parent = document.createElement(tag);
    document.body.append(parent);
    const cases = [STATUS_CASES['needs-human'], STATUS_CASES.working];
    const { host, dispose } = mountControllerPanes({ terminals: cases.map(c => c.terminal), parent });
    try {
      const header = windowHeaderIn(host)?.textContent ?? '';
      expect({
        total: /(?<![\w-])2\s*(?:total|cards?|terminals?)\b|\b(?:total|cards?|terminals?)\W*2(?!\d)/i.test(header),
        statuses: cases.map(c => { const card = cardIn(host, c.terminal.launchDirectory); return card ? statusRowIn(card)?.textContent?.trim() : undefined; }),
      }).toEqual({ total: true, statuses: cases.map(c => c.text) });
    } finally { dispose(); }
  });
});

describe('controller panes identity', () => {
  const single = { ...statusTerminal({ title: 'Single card title', branch: 'single/card-branch' }), id: 'single', launchDirectory: '/identity/single', repositoryRoot: '/identity' };
  const members = ['one', 'two'].map(key => ({
    ...statusTerminal({ title: `Member ${key} title`, branch: `member/${key}-branch` }),
    id: `member-${key}`, launchDirectory: '/identity/shared', repositoryRoot: '/identity',
  }));

  it('shows a single card\'s title and branch in its header, and neither on a duplicate-directory card', () => {
    const { host, dispose } = mountControllerPanes({ terminals: [single, ...members] });
    try {
      const singleCard = cardIn(host, single.launchDirectory);
      const conflictCard = cardIn(host, members[0].launchDirectory);
      const singleHeader = singleCard ? cardHeaderTextIn(singleCard) : '';
      const conflictHeader = conflictCard ? cardHeaderTextIn(conflictCard) : '';
      expect({
        single: [singleHeader.includes('Single card title'), singleHeader.includes('single/card-branch')],
        conflict: [conflictHeader.length > 0, ...['Member one title', 'member/one-branch', 'Member two title', 'member/two-branch'].map(text => conflictHeader.includes(text))],
      }).toEqual({ single: [true, true], conflict: [true, false, false, false, false] });
    } finally { dispose(); }
  });

  it('shows no title or branch anywhere in a duplicate-directory card', () => {
    const { host, dispose } = mountControllerPanes({ terminals: members });
    try {
      const text = cardIn(host, members[0].launchDirectory)?.textContent ?? '';
      expect(['Member one title', 'member/one-branch', 'Member two title', 'member/two-branch'].filter(part => text.includes(part))).toEqual([]);
    } finally { dispose(); }
  });
});
