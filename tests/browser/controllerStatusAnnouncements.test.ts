import { page } from 'vitest/browser';
import { expect, it } from 'vitest';
import '../../src/renderer/src/styles.css';
import { createControllerPanes } from '../../src/renderer/src/controllerPanes';
import { statusService, statusTerminal } from '../helpers/controllerStatusFixture';

it('announces another pane entering, changing and clearing attention without focus movement or repeat announcements', () => {
  const host = document.createElement('main');
  document.body.append(host);
  const other = { ...statusTerminal(), id: 'other', launchDirectory: '/other' };
  const service = statusService([statusTerminal(), other]);
  const panes = createControllerPanes(host, { controller: service.api });
  try {
    const live = page.elementLocator(host).getByRole('status').element();
    expect(live).not.toBeNull();
    const peerButton = page.elementLocator(host).getByRole('button', { name: /\/other/ });
    (peerButton.element() as HTMLElement).focus();
    const blocked = statusTerminal({ attention: { status: 'complete', reasons: ['Review required'] } });
    service.publish([blocked, other]);
    expect(live!.textContent).toContain('/fixed/worktree');
    expect(live!.textContent).toContain('Review required');
    const observer = new MutationObserver(() => {});
    observer.observe(live, { childList: true, subtree: true, characterData: true });
    service.publish([blocked, other]);
    expect(observer.takeRecords(), 'unchanged attention must not trigger another live-region announcement').toEqual([]);
    observer.disconnect();
    service.publish([statusTerminal({ attention: { status: 'error', reasons: ['Check failed'] }, error: { reason: 'Broken build' } }), other]);
    expect(live!.textContent).toContain('Check failed');
    expect(live!.textContent).toContain('Broken build');
    service.publish([statusTerminal(), other]);
    expect(live!.textContent).toContain('/fixed/worktree');
    expect(live!.textContent).toContain('cleared');
    expect(document.activeElement).toBe(peerButton.element());
    expect(service.activated).toEqual([]);
  } finally { panes.dispose(); host.remove(); }
});
