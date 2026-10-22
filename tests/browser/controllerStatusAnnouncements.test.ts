import { expect, it } from 'vitest';
import '../../src/renderer/src/styles.css';
import { createControllerPanes } from '../../src/renderer/src/controllerPanes';
import { statusService, statusTerminal } from '../helpers/controllerStatusFixture';

it.each(['light', 'dark'])('distinguishes assigned and unassigned through themed colors in %s', theme => {
  document.documentElement.dataset.theme = theme;
  const host = document.createElement('main');
  document.body.append(host);
  const service = statusService();
  const panes = createControllerPanes(host, { controller: service.api });
  try {
    const assigned = getComputedStyle(host.querySelector('.controller-assignment-assigned')!).color;
    service.publish([statusTerminal({ flow: { availability: 'known', name: 'work', step: 'start', assignment: 'unassigned' } })]);
    const unassigned = getComputedStyle(host.querySelector('.controller-assignment-unassigned')!).color;
    expect(unassigned).not.toBe(assigned);
  } finally { panes.dispose(); host.remove(); document.documentElement.removeAttribute('data-theme'); }
});

it('announces another pane entering, changing and clearing attention without focus movement or repeat announcements', () => {
  const host = document.createElement('main');
  document.body.append(host);
  const other = { ...statusTerminal(), id: 'other', launchDirectory: '/other' };
  const service = statusService([statusTerminal(), other]);
  const panes = createControllerPanes(host, { controller: service.api });
  try {
    const live = host.querySelector('[role="status"]');
    expect(live).not.toBeNull();
    host.querySelector<HTMLButtonElement>('[data-terminal-id="other"]')!.focus();
    const blocked = statusTerminal({ attention: { status: 'complete', reasons: ['Review required'] } });
    service.publish([blocked, other]);
    expect(live!.textContent).toContain('/fixed/worktree');
    expect(live!.textContent).toContain('Review required');
    const announcement = live!.firstChild;
    service.publish([blocked, other]);
    expect(live!.firstChild).toBe(announcement);
    service.publish([statusTerminal({ attention: { status: 'error', reasons: ['Check failed'] }, error: { reason: 'Broken build' } }), other]);
    expect(live!.textContent).toContain('Check failed');
    expect(live!.textContent).toContain('Broken build');
    service.publish([statusTerminal(), other]);
    expect(live!.textContent).toContain('/fixed/worktree');
    expect(live!.textContent).toContain('cleared');
    expect((document.activeElement as HTMLElement).dataset.terminalId).toBe('other');
    expect(service.activated).toEqual([]);
  } finally { panes.dispose(); host.remove(); }
});
