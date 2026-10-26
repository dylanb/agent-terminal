import { page } from 'vitest/browser';
import { expect, it } from 'vitest';
import '../helpers/rendererTokens';
import '../../src/renderer/src/styles.css';
import '../helpers/rendererTokens';
import { bringForwardIn, cardIn, statusRowIn } from '../helpers/controllerCards';
import { mountControllerPanes } from '../helpers/controllerMount';
import { statusTerminal } from '../helpers/controllerStatusFixture';

it.each(['light', 'dark'])('distinguishes a working and an unassigned card through themed status colours in %s', theme => {
  document.documentElement.dataset.theme = theme;
  const { host, service, dispose } = mountControllerPanes();
  const statusColor = () => {
    const card = cardIn(host, statusTerminal().launchDirectory);
    const row = card ? statusRowIn(card) : null;
    return row ? getComputedStyle(row).color : undefined;
  };
  try {
    const working = statusColor();
    service.publish([statusTerminal({ flow: { availability: 'known', name: 'work', step: 'start', assignment: 'unassigned' } })]);
    const unassigned = statusColor();
    expect({ painted: working !== undefined && unassigned !== undefined, distinct: working !== unassigned }).toEqual({ painted: true, distinct: true });
  } finally { dispose(); document.documentElement.removeAttribute('data-theme'); }
});

it('announces another pane entering, changing and clearing attention without focus movement or repeat announcements', () => {
  const other = { ...statusTerminal(), id: 'other', launchDirectory: '/other' };
  const { host, service, dispose } = mountControllerPanes({ terminals: [statusTerminal(), other] });
  const peerButton = () => { const card = cardIn(host, '/other'); return card ? bringForwardIn(card) : undefined; };
  try {
    const live = page.elementLocator(host).getByRole('status').element();
    expect(live).not.toBeNull();
    peerButton()?.focus();
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
    expect(live!.textContent).toContain('/fixed/worktree: Human needed: error. Check failed. Error. Broken build');
    service.publish([statusTerminal(), other]);
    expect(live!.textContent).toContain('/fixed/worktree');
    expect(live!.textContent).toContain('cleared');
    expect({ peer: Boolean(peerButton()), focused: document.activeElement === peerButton() }).toEqual({ peer: true, focused: true });
    expect(service.activated).toEqual([]);
  } finally { dispose(); }
});
