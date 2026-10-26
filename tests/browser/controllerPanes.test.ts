import { afterEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import '../../src/renderer/src/styles.css';
import type { ControllerTerminal } from '../../src/shared/ipc';
import { bringForwardIn, cardIn, dismissIn, statusRowIn, windowHeaderIn } from '../helpers/controllerCards';
import { mountControllerPanes } from '../helpers/controllerMount';
import { STATUS_CASES } from '../helpers/controllerStatusFixture';

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

  it('brings a terminal forward through native keyboard interaction', async () => {
    const { host, activated, component } = mount();
    try {
      await tabTo(control(host, terminals[0].launchDirectory, bringForwardIn));
      await userEvent.keyboard('{Enter}');
      expect(activated).toEqual(['a']);
    } finally { component.dispose(); }
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
        total: /(?<![\w-])2\s*(?:total|terminals?)\b|\b(?:total|terminals?)\W*2(?!\d)/i.test(header),
        statuses: cases.map(c => { const card = cardIn(host, c.terminal.launchDirectory); return card ? statusRowIn(card)?.textContent?.trim() : undefined; }),
      }).toEqual({ total: true, statuses: ['Needs a human', 'Working'] });
    } finally { dispose(); }
  });
});
