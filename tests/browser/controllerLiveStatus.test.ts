import { afterEach, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import '../../src/renderer/src/styles.css';
import { createControllerPanes } from '../../src/renderer/src/controllerPanes';
import { statusService, statusTerminal } from '../helpers/controllerStatusFixture';

afterEach(() => {
  document.body.replaceChildren();
});

it('keeps the full reason available and keyboard activation reachable beside a long title', async () => {
  const host = document.createElement('aside');
  document.body.append(host);
  const title = 'A long issue title '.repeat(30);
  const reason = 'The full failure reason must remain accessible. '.repeat(80);
  const terminal = statusTerminal({
    ticket: { availability: 'known', number: 219, title: { availability: 'known', text: title } },
    attention: { status: 'complete', reasons: [reason] },
  });
  terminal.launchDirectory = '/work/' + 'long-worktree-'.repeat(25);
  const component = createControllerPanes(host, { controller: statusService([terminal]).api });
  try {
    expect.soft(host.textContent, 'full reason available to assistive technology').toContain(reason);
    await userEvent.tab();
    const focused = document.activeElement as HTMLElement;
    expect.soft(host.contains(focused) && focused.tagName === 'BUTTON', 'keyboard activation remains reachable').toBe(true);
  } finally { component.dispose(); }
});
