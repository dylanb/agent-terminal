import { afterEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import '../../src/renderer/src/styles.css';
import { createControllerPanes } from '../../src/renderer/src/controllerPanes';
import type { ControllerApi, ControllerTerminal } from '../../src/shared/ipc';

const terminals: ControllerTerminal[] = [
  { id: 'a', launchDirectory: '/left/project/a-long-launch-directory', repositoryRoot: '/left/project' },
  { id: 'b', launchDirectory: '/right/project/another-long-launch-directory', repositoryRoot: '/right/project' },
];

afterEach(() => {
  document.body.replaceChildren();
});

describe('controller panes', () => {
  function mount(items: ControllerTerminal[] = terminals) {
    const host = document.createElement('main');
    document.body.append(host);
    const activated: string[] = [];
    const controller: ControllerApi & { dismissTerminal(id: string): Promise<void> } = {
      subscribeTerminals(listener) { listener(items); return () => {}; },
      async dismissTerminal() {},
      async activateTerminal(id) { activated.push(id); return 'activated'; },
    };
    return { host, activated, component: createControllerPanes(host, { controller }) };
  }

  it('moves keyboard focus to the dismiss control', async () => {
    const { host, component } = mount([{ ...terminals[0], status: 'disconnected' }]);
    try {
      await userEvent.tab();
      const button = [...host.querySelectorAll('button')].find(item => /dismiss/i.test(item.getAttribute('aria-label') ?? item.textContent ?? ''));
      expect(button).toBeDefined();
      expect(document.activeElement).toBe(button);
    } finally { component.dispose(); }
  });

  it('activates a terminal through native keyboard interaction', async () => {
    const { activated, component } = mount();
    try {
      await userEvent.tab();
      await userEvent.keyboard('{Enter}');
      expect(activated).toEqual(['a']);
    } finally { component.dispose(); }
  });

  it('moves keyboard focus through each activation control in order', async () => {
    const { host, component } = mount();
    try {
      for (const button of host.querySelectorAll('button')) {
        await userEvent.tab();
        expect.soft(document.activeElement).toBe(button);
      }
    } finally { component.dispose(); }
  });
});
