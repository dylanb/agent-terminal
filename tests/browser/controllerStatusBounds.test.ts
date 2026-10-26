import { expect, it } from 'vitest';
import type { ControllerWorkStatus } from '../../src/shared/ipc';
import { bringForwardIn, cardIn } from '../helpers/controllerCards';
import { mountControllerPanes } from '../helpers/controllerMount';
import { statusTerminal } from '../helpers/controllerStatusFixture';

it('shows and announces oversized status without claiming the human gate cleared, and keeps Bring forward available', async () => {
  const { host, service, dispose } = mountControllerPanes();
  const card = () => cardIn(host, statusTerminal().launchDirectory);
  try {
    service.publish([statusTerminal({ attention: { status: 'complete', reasons: ['Review required'] } })]);
    const unavailable = statusTerminal({ flow: { availability: 'unavailable' }, ticket: { availability: 'unavailable' }, activity: 'unavailable' });
    const work: ControllerWorkStatus = { ...unavailable.work, unavailableReason: 'message-too-large' };
    service.publish([{ ...unavailable, work }]);
    const oversized = card();
    expect.soft(oversized?.textContent ?? '').toContain('Status unavailable: message exceeds 1 MiB. Open the terminal for the full reason.');
    expect.soft(host.querySelector('[role="status"]')!.textContent).toContain('Status unavailable');
    expect.soft(host.querySelector('[role="status"]')!.textContent).not.toContain('cleared');
    const button = oversized ? bringForwardIn(oversized) : undefined;
    button?.click();
    expect.soft(service.activated).toHaveLength(1);
    service.publish([statusTerminal()]);
    const current = card();
    expect.soft({ bringForward: Boolean(current && bringForwardIn(current)), text: current?.textContent?.includes('Status unavailable') ?? true })
      .toEqual({ bringForward: true, text: false });
  } finally { dispose(); }
});
