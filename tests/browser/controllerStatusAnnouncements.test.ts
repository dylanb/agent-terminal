import { page } from 'vitest/browser';
import { expect, it } from 'vitest';
import '../../src/renderer/src/styles.css';
import { bringForwardIn, cardIn } from '../helpers/controllerCards';
import { mountControllerPanes } from '../helpers/controllerMount';
import { statusTerminal } from '../helpers/controllerStatusFixture';

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

it('makes no announcement when only the activity of a terminal with a condition changes', () => {
  const blocked = (activity: 'active' | 'quiet' | 'unavailable') =>
    statusTerminal({ attention: { status: 'complete', reasons: ['Review required'] }, error: { reason: 'Broken build' }, activity });
  const { host, service, dispose } = mountControllerPanes({ terminals: [blocked('active')] });
  try {
    const live = page.elementLocator(host).getByRole('status').element();
    const announced = live.textContent;
    const observer = new MutationObserver(() => {});
    observer.observe(live, { childList: true, subtree: true, characterData: true });
    for (const activity of ['quiet', 'unavailable', 'active'] as const) service.publish([blocked(activity)]);
    const mutations = observer.takeRecords().length;
    observer.disconnect();
    expect({ announced: announced?.includes('Review required'), mutations, text: live.textContent }).toEqual({ announced: true, mutations: 0, text: announced });
  } finally { dispose(); }
});
