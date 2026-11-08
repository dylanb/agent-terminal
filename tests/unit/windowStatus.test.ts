import { describe, expect, it } from 'vitest';
import { createWindowStatus, type WindowStatusUpdate } from '../../src/main/windowStatus';
import type { ShadowStatus } from '../../src/main/shadow';
import type { WaitingValue } from '../../src/shared/waiting';

const quiet = (quietSince: number): ShadowStatus => ({ altScreen: false, bracketedPaste: false, agentState: 'quiet', quietSince });
const ACTIVE: ShadowStatus = { altScreen: false, bracketedPaste: false, agentState: 'active', quietSince: null };

function harness() {
  const delivered: WindowStatusUpdate[] = [];
  const window = createWindowStatus({ deliver: (update) => delivered.push(update) });
  const setWaiting = (value: WaitingValue | null): void => window.activity(value ? { activity: 'waiting', waiting: value } : { activity: 'quiet' });
  return { window, delivered, setWaiting };
}

describe('the window status (#319 AC6, AC11)', () => {
  it('delivers each screen status with the Waiting value the window shows', () => {
    const { window, delivered, setWaiting } = harness();
    setWaiting({ program: 'node', others: 0 });
    window.screen(quiet(1));
    expect(delivered).toEqual([{ ...quiet(1), waiting: { program: 'node', others: 0 } }]);
  });

  it('delivers nothing on an activity that changes nothing the window shows', () => {
    const { window, delivered, setWaiting } = harness();
    window.screen(quiet(1));
    setWaiting(null);
    window.activity({ activity: 'active' });
    setWaiting({ program: 'node', others: 1 });
    setWaiting({ program: 'node', others: 1 });
    expect(delivered.map((update) => update.waiting)).toEqual([null, { program: 'node', others: 1 }]);
  });

  it('delivers when Waiting ends while the screen stays quiet', () => {
    const { window, delivered, setWaiting } = harness();
    setWaiting({ program: 'node', others: 0 });
    window.screen(quiet(1));
    setWaiting(null);
    expect(delivered.map((update) => update.waiting)).toEqual([{ program: 'node', others: 0 }, null]);
  });

  it('delivers each change of label while the screen stays quiet', () => {
    const { window, delivered, setWaiting } = harness();
    setWaiting({ program: 'node', others: 0 });
    window.screen(quiet(1));
    setWaiting({ program: 'node', others: 1 });
    setWaiting({ program: 'pytest', others: 1 });
    expect(delivered.map((update) => update.waiting)).toEqual([
      { program: 'node', others: 0 },
      { program: 'node', others: 1 },
      { program: 'pytest', others: 1 },
    ]);
  });

  it('never delivers a Waiting value beside an active screen, whatever the source reports', () => {
    const { window, delivered, setWaiting } = harness();
    setWaiting({ program: 'node', others: 0 });
    window.screen(ACTIVE);
    setWaiting({ program: 'pytest', others: 0 });
    expect(delivered).toEqual([{ ...ACTIVE, waiting: null }]);
  });

  it('delivers every new screen status, as the window received them before #319', () => {
    const { window, delivered } = harness();
    window.screen(quiet(1));
    window.screen(quiet(1));
    expect(delivered).toHaveLength(2);
  });

  it('reports the screen activity and the Waiting value it last delivered, for the flow strip', () => {
    const { window, setWaiting } = harness();
    setWaiting({ program: 'node', others: 0 });
    const shown = [window.shown()];
    window.screen(quiet(1));
    shown.push(window.shown());
    window.screen(ACTIVE);
    shown.push(window.shown());
    window.screen(quiet(2));
    setWaiting(null);
    shown.push(window.shown());
    expect(shown).toEqual([
      { agentState: 'quiet', waiting: null },
      { agentState: 'quiet', waiting: { program: 'node', others: 0 } },
      { agentState: 'active', waiting: null },
      { agentState: 'quiet', waiting: null },
    ]);
  });

  it('delivers nothing before the first screen status', () => {
    const { delivered, setWaiting } = harness();
    setWaiting({ program: 'node', others: 0 });
    expect(delivered).toEqual([]);
  });
});
