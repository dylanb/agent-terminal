import { page } from 'vitest/browser';
import { expect, it } from 'vitest';
import '../../src/renderer/src/styles.css';
import { createControllerPanes } from '../../src/renderer/src/controllerPanes';
import { statusService, statusTerminal } from '../helpers/controllerStatusFixture';

it('does not retain live attention after disconnect, dismissal or recovery', () => {
  const host = document.createElement('main');
  document.body.append(host);
  const blocked = statusTerminal({ attention: { status: 'complete', reasons: ['OUTDATED_HALT'] }, error: { reason: 'OUTDATED_ERROR' } });
  const peer = { ...statusTerminal(), id: 'peer', launchDirectory: '/peer' };
  const service = statusService([blocked, peer]);
  const panes = createControllerPanes(host, { controller: service.api });
  try {
    expect(host.textContent).toContain('OUTDATED_HALT');
    const peerButton = page.elementLocator(host).getByRole('button', { name: /\/peer/ });
    (peerButton.element() as HTMLElement).focus();
    service.publish([{ ...blocked, status: 'disconnected' }, peer]);
    expect.soft(host.textContent).toMatch(/disconnected/i);
    expect.soft(!/OUTDATED_HALT|OUTDATED_ERROR/.test(host.textContent ?? '') || /last.known/i.test(host.textContent ?? ''), 'disconnected details must be absent or explicitly last-known').toBe(true);
    expect.soft(document.activeElement).toBe(peerButton.element());
    service.publish([peer]);
    expect.soft(host.textContent, 'dismissal removes the ended terminal attention').not.toMatch(/OUTDATED_HALT|OUTDATED_ERROR/);
    const recovered = { ...statusTerminal({ flow: { availability: 'known', name: 'current-flow', step: 'verify', assignment: 'assigned' } }), id: 'recovered' };
    service.publish([recovered, peer]);
    expect.soft(host.textContent).toContain('current-flow');
    expect.soft(host.textContent, 'recovery cannot replay obsolete attention').not.toMatch(/OUTDATED_HALT|OUTDATED_ERROR/);
    expect.soft(document.activeElement).toBe(peerButton.element());
    expect(service.activated).toEqual([]);
  } finally { panes.dispose(); host.remove(); }
});
