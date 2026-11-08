import { describe, expect, it } from 'vitest';
import { createWindowStatus, type WindowStatusUpdate } from '../../src/main/windowStatus';
import type { ShadowStatus } from '../../src/main/shadow';
import type { WaitingValue } from '../../src/shared/waiting';

const quiet = (quietSince: number): ShadowStatus => ({ altScreen: false, bracketedPaste: false, agentState: 'quiet', quietSince });
const ACTIVE: ShadowStatus = { altScreen: false, bracketedPaste: false, agentState: 'active', quietSince: null };

function harness() {
  let waiting: WaitingValue | null = null;
  const delivered: WindowStatusUpdate[] = [];
  const window = createWindowStatus({ waiting: () => waiting, deliver: (update) => delivered.push(update) });
  return { window, delivered, setWaiting: (value: WaitingValue | null) => { waiting = value; } };
}

describe('the window status (#319 AC6, AC11)', () => {
  it('delivers each screen status with the Waiting value the window shows', () => {
    const { window, delivered, setWaiting } = harness();
    setWaiting({ program: 'node', others: 0 });
    window.screen(quiet(1));
    expect(delivered).toEqual([{ status: quiet(1), waiting: { program: 'node', others: 0 } }]);
  });

  it('delivers nothing on a refresh that changes nothing the window shows', () => {
    const { window, delivered, setWaiting } = harness();
    window.screen(quiet(1));
    window.refresh();
    setWaiting({ program: 'node', others: 1 });
    window.refresh();
    setWaiting({ program: 'node', others: 1 });
    window.refresh();
    expect(delivered.map((update) => update.waiting)).toEqual([null, { program: 'node', others: 1 }]);
  });

  it('delivers when Waiting ends while the screen stays quiet', () => {
    const { window, delivered, setWaiting } = harness();
    setWaiting({ program: 'node', others: 0 });
    window.screen(quiet(1));
    setWaiting(null);
    window.refresh();
    expect(delivered.map((update) => update.waiting)).toEqual([{ program: 'node', others: 0 }, null]);
  });

  it('never delivers a Waiting value beside an active screen, whatever the source reports', () => {
    const { window, delivered, setWaiting } = harness();
    setWaiting({ program: 'node', others: 0 });
    window.screen(ACTIVE);
    window.refresh();
    expect(delivered).toEqual([{ status: ACTIVE, waiting: null }]);
  });

  it('delivers every new screen status, as the window received them before #319', () => {
    const { window, delivered } = harness();
    window.screen(quiet(1));
    window.screen(quiet(1));
    expect(delivered).toHaveLength(2);
  });

  it('delivers nothing before the first screen status', () => {
    const { window, delivered, setWaiting } = harness();
    setWaiting({ program: 'node', others: 0 });
    window.refresh();
    expect(delivered).toEqual([]);
  });
});
