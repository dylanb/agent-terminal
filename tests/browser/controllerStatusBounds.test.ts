import { expect, it } from 'vitest';
import type { ControllerWorkStatus } from '../../src/shared/ipc';
import { createControllerPanes } from '../../src/renderer/src/controllerPanes';
import { statusService, statusTerminal } from '../helpers/controllerStatusFixture';

it('shows and announces oversized status without claiming the human gate cleared, and keeps activation available', async () => {
  const host = document.createElement('main');
  document.body.append(host);
  const service = statusService();
  const panes = createControllerPanes(host, { controller: service.api });
  try {
    service.publish([statusTerminal({ attention: { status: 'complete', reasons: ['Review required'] } })]);
    const unavailable = statusTerminal({ flow: { availability: 'unavailable' }, ticket: { availability: 'unavailable' }, activity: 'unavailable' });
    const work: ControllerWorkStatus = { ...unavailable.work, unavailableReason: 'message-too-large' };
    service.publish([{ ...unavailable, work }]);
    const button = host.querySelector('button')!;
    expect(button.textContent).toContain('Status unavailable: message exceeds 1 MiB. Open the terminal for the full reason.');
    expect(host.querySelector('[role="status"]')!.textContent).toContain('Status unavailable');
    expect(host.querySelector('[role="status"]')!.textContent).not.toContain('cleared');
    button.click();
    expect(service.activated).toHaveLength(1);
    service.publish([statusTerminal()]);
    expect(button.isConnected).toBe(false);
    expect(host.querySelector('button')!.textContent).not.toContain('Status unavailable');
  } finally { panes.dispose(); host.remove(); }
});
