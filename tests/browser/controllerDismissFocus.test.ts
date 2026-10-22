import { afterEach, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { createControllerPanes } from '../../src/renderer/src/controllerPanes';
import type { ControllerTerminal } from '../../src/shared/ipc';

afterEach(() => document.body.replaceChildren());

function mount(count: number) {
  const host = document.createElement('main');
  document.body.append(host);
  let items: ControllerTerminal[] = Array.from({ length: count }, (_, index) => ({
    id: String(index), launchDirectory: `/work/${index}`, repositoryRoot: '/work', status: 'disconnected',
  }));
  let publish!: (items: ControllerTerminal[]) => void;
  const dismissed: string[] = [];
  const component = createControllerPanes(host, { controller: {
    subscribeTerminals(listener) { publish = listener; listener(items); return () => {}; },
    async activateTerminal() { return 'activated'; },
    async dismissTerminal(id) {
      dismissed.push(id);
      items = items.filter(item => item.id !== id);
      publish(items);
    },
  } });
  return { host, dismissed, component, register() {
    items = [...items, { id: 'live', launchDirectory: '/other', repositoryRoot: null }];
    publish(items);
  } };
}

it('preserves Dismiss focus and keyboard targeting across an unrelated registration', async () => {
  const view = mount(2);
  try {
    await userEvent.tab();
    await userEvent.tab();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Dismiss disconnected terminal /work/1');
    view.register();
    expect.soft(document.activeElement?.getAttribute('aria-label')).toBe('Dismiss disconnected terminal /work/1');
    await userEvent.keyboard('{Enter}');
    expect.soft(view.dismissed).toEqual(['1']);
    expect.soft([...view.host.querySelectorAll('button')].map(button => button.getAttribute('aria-label')))
      .toEqual(['Dismiss disconnected terminal /work/0', null]);
  } finally { view.component.dispose(); }
});

it('moves focus to a remaining actionable control after dismissing a disconnected pane', async () => {
  const view = mount(2);
  try {
    await userEvent.tab();
    await userEvent.keyboard('{Enter}');
    expect(view.dismissed).toEqual(['0']);
    expect.soft(document.activeElement?.getAttribute('aria-label')).toBe('Dismiss disconnected terminal /work/1');
    await userEvent.keyboard('{Enter}');
    expect.soft(view.dismissed).toEqual(['0', '1']);
  } finally { view.component.dispose(); }
});

it('focuses connection guidance when dismissal leaves no panes', async () => {
  const view = mount(1);
  try {
    await userEvent.tab();
    await userEvent.keyboard('{Enter}');
    expect(view.dismissed).toEqual(['0']);
    expect(view.host.querySelectorAll('button')).toHaveLength(0);
    expect(document.activeElement?.textContent).toBe('No terminals connected. Launch a terminal while the controller is running.');
    expect(view.host.contains(document.activeElement)).toBe(true);
  } finally { view.component.dispose(); }
});
