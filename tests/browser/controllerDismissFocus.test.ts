import { afterEach, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { ControllerTerminal } from '../../src/shared/ipc';
import { bringForwardIn, cardIn, cardsIn, dismissIn } from '../helpers/controllerCards';
import { mountControllerPanes } from '../helpers/controllerMount';

afterEach(() => document.body.replaceChildren());

function mount(count: number) {
  const stale: ControllerTerminal[] = Array.from({ length: count }, (_, index) => ({
    id: String(index), launchDirectory: `/work/${index}`, repositoryRoot: '/work', status: 'disconnected',
  }));
  const { host, service, dispose } = mountControllerPanes({ terminals: stale });
  const live: ControllerTerminal = { id: 'live', launchDirectory: '/other', repositoryRoot: null };
  return {
    host, dismissed: service.dismissed, component: { dispose },
    dismiss: (directory: string) => { const card = cardIn(host, directory); return card ? dismissIn(card) : undefined; },
    register() { service.publish([...stale.filter(item => !service.dismissed.includes(item.id)), live]); },
  };
}

it('preserves Dismiss focus and keyboard targeting across an unrelated registration', async () => {
  const view = mount(2);
  try {
    view.dismiss('/work/1')?.focus();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Dismiss disconnected terminal /work/1');
    view.register();
    expect.soft(document.activeElement?.getAttribute('aria-label')).toBe('Dismiss disconnected terminal /work/1');
    await userEvent.keyboard('{Enter}');
    expect.soft(view.dismissed).toEqual(['1']);
    const other = cardIn(view.host, '/other');
    expect.soft({
      remaining: Boolean(view.dismiss('/work/0')),
      dismissedCard: Boolean(cardIn(view.host, '/work/1')),
      registered: Boolean(other && bringForwardIn(other)),
    }).toEqual({ remaining: true, dismissedCard: false, registered: true });
  } finally { view.component.dispose(); }
});

it('moves focus to a remaining actionable control after dismissing a disconnected card', async () => {
  const view = mount(2);
  try {
    view.dismiss('/work/0')?.focus();
    await userEvent.keyboard('{Enter}');
    expect(view.dismissed).toEqual(['0']);
    expect.soft(document.activeElement?.getAttribute('aria-label')).toBe('Dismiss disconnected terminal /work/1');
    await userEvent.keyboard('{Enter}');
    expect.soft(view.dismissed).toEqual(['0', '1']);
  } finally { view.component.dispose(); }
});

it('focuses connection guidance when dismissal leaves no cards', async () => {
  const view = mount(1);
  try {
    view.dismiss('/work/0')?.focus();
    await userEvent.keyboard('{Enter}');
    expect(view.dismissed).toEqual(['0']);
    expect(cardsIn(view.host)).toHaveLength(0);
    expect(document.activeElement?.textContent).toBe('No terminals connected. Launch a terminal while the controller is running.');
    expect(view.host.contains(document.activeElement)).toBe(true);
  } finally { view.component.dispose(); }
});
