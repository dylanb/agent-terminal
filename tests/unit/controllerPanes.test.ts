// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createControllerPanes } from '../../src/renderer/src/controllerPanes';
import type { ControllerApi, ControllerTerminal } from '../../src/shared/ipc';

const terminal: ControllerTerminal = { id: 'terminal-a', launchDirectory: '/left/project/nested', repositoryRoot: '/left/project' };

function service(initial: ControllerTerminal[] = [terminal], outcome: 'activated' | 'unavailable' = 'activated') {
  const listeners = new Set<(terminals: ControllerTerminal[]) => void>();
  const activated: string[] = [];
  const api: ControllerApi = {
    subscribeTerminals(listener) {
      listeners.add(listener);
      listener(initial);
      return () => { listeners.delete(listener); };
    },
    async activateTerminal(id) {
      activated.push(id);
      return outcome;
    },
  };
  return { api, activated, publish: (items: ControllerTerminal[]) => listeners.forEach(listener => listener(items)) };
}

afterEach(() => document.body.replaceChildren());

describe('controller panes', () => {
  it.each(['aside', 'main'])('identifies launch and repository when mounted in %s', tag => {
    const host = document.createElement(tag);
    document.body.append(host);
    const component = createControllerPanes(host, { controller: service().api });
    try {
      expect.soft(host.textContent).toContain(terminal.launchDirectory);
      expect.soft(host.textContent).toContain(`Repository: ${terminal.repositoryRoot}`);
    } finally { component.dispose(); }
  });

  it('renders a non-Git launch as directory data', () => {
    const host = document.createElement('section');
    const directory = '/tmp/<img src=x onerror=alert(1)>';
    const component = createControllerPanes(host, { controller: service([{ id: 'non-git', launchDirectory: directory, repositoryRoot: null }]).api });
    try {
      expect.soft(host.textContent).toContain(directory);
      expect.soft(host.querySelector('img')).toBeNull();
      expect.soft(host.textContent).not.toContain('Repository:');
    } finally { component.dispose(); }
  });

  it('activates the clicked opaque terminal identity even for equal directories', async () => {
    const host = document.createElement('section');
    const target = { ...terminal, id: 'terminal-b' };
    const s = service([terminal, target]);
    const component = createControllerPanes(host, { controller: s.api });
    try {
      const buttons = host.querySelectorAll('button');
      expect(buttons).toHaveLength(2);
      buttons[1].click();
      await vi.waitFor(() => expect(s.activated).toEqual(['terminal-b']));
    } finally { component.dispose(); }
  });

  it('announces unavailable activation without removing a still-connected pane', async () => {
    const host = document.createElement('section');
    document.body.append(host);
    const s = service([terminal], 'unavailable');
    const component = createControllerPanes(host, { controller: s.api });
    try {
      const button = host.querySelector('button');
      expect(button).not.toBeNull();
      button!.click();
      await vi.waitFor(() => expect({
        message: host.querySelector('[role="alert"]')?.textContent ?? '',
        panes: host.querySelectorAll('button').length,
      }).toEqual({ message: expect.stringMatching(/terminal unavailable/i), panes: 1 }));
    } finally { component.dispose(); }
  });

  it('explains the empty state after the last connection ends', () => {
    const host = document.createElement('section');
    const s = service();
    const component = createControllerPanes(host, { controller: s.api });
    try {
      s.publish([]);
      expect.soft(host.textContent).toMatch(/no terminals (?:are )?connected/i);
      expect.soft(host.textContent).toMatch(/launch.*terminal.*controller.*running/i);
    } finally { component.dispose(); }
  });

  it('keeps keyboard focus reachable after its focused pane disconnects', () => {
    const host = document.createElement('section');
    document.body.append(host);
    const survivor = { ...terminal, id: 'survivor', launchDirectory: '/right/project' };
    const s = service([terminal, survivor]);
    const component = createControllerPanes(host, { controller: s.api });
    try {
      host.querySelector('button')!.focus();
      s.publish([survivor]);
      expect(host.contains(document.activeElement)).toBe(true);
    } finally { component.dispose(); }
  });

  it('removes its DOM and cannot render later service updates after disposal', () => {
    const host = document.createElement('section');
    const s = service();
    const component = createControllerPanes(host, { controller: s.api });
    component.dispose();
    s.publish([{ ...terminal, id: 'later' }]);
    expect(host.childElementCount).toBe(0);
  });

  it('does not steal focus from outside when a terminal disconnects', () => {
    const host = document.createElement('section');
    const outside = document.createElement('button');
    outside.textContent = 'Settings';
    document.body.append(host, outside);
    const survivor = { ...terminal, id: 'survivor' };
    const s = service([terminal, survivor]);
    const component = createControllerPanes(host, { controller: s.api });
    try {
      outside.focus();
      s.publish([survivor]);
      expect(document.activeElement).toBe(outside);
    } finally { component.dispose(); }
  });

  it.each(['unavailable', 'rejected'] as const)('does not render a pending %s activation after disposal', async outcome => {
    const host = document.createElement('section');
    const s = service();
    let resolve!: (value: 'unavailable') => void;
    let reject!: (error: Error) => void;
    const pending = new Promise<'unavailable'>((done, fail) => { resolve = done; reject = fail; });
    s.api.activateTerminal = () => pending;
    const component = createControllerPanes(host, { controller: s.api });
    host.querySelector('button')!.click();
    component.dispose();
    if (outcome === 'unavailable') resolve('unavailable');
    else reject(new Error('Connection closed'));
    await pending.catch(() => {});
    expect(host.childElementCount).toBe(0);
  });
});
