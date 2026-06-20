// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStatusStrip } from '../../src/renderer/src/statusStrip';
import type { MonitorUpdateMsg } from '../../src/shared/ipc';

// §8.3 — while the agent is quiet the strip shows a live "quiet for Ns" counter driven by a 1 s
// tick and an injectable clock; it must appear only while quiet, increment on the tick, disappear
// when the agent goes active, and stop ticking on dispose. Tests assert observable DOM only.

const upd = (over: Partial<MonitorUpdateMsg>): MonitorUpdateMsg => ({
  sessionId: 's1',
  altScreen: false,
  bracketedPaste: false,
  agentState: 'quiet',
  quietSince: null,
  ...over,
});

describe('statusStrip — live quiet counter (§8.3)', () => {
  let el: HTMLElement;
  const counter = () => el.querySelector('.quiet-counter');

  beforeEach(() => {
    el = document.createElement('div');
    document.body.appendChild(el);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    el.remove();
  });

  it('renders the quiet counter and increments it on each tick', () => {
    let t = 10_000;
    const strip = createStatusStrip(el, () => t);
    strip.update(upd({ agentState: 'quiet', quietSince: 10_000 }));
    expect(counter()).not.toBeNull();
    expect(counter()!.textContent).toBe(' for 0s');
    t = 13_000;
    vi.advanceTimersByTime(1000);
    expect(counter()!.textContent).toBe(' for 3s');
    strip.dispose();
  });

  it('removes the counter and stops ticking when the agent goes active', () => {
    let t = 0;
    const strip = createStatusStrip(el, () => t);
    strip.update(upd({ agentState: 'quiet', quietSince: 0 }));
    expect(counter()).not.toBeNull();

    strip.update(upd({ agentState: 'active', quietSince: null }));
    expect(counter()).toBeNull();
    // The prior quiet tick must have been cleared: advancing time creates no counter.
    t = 5_000;
    vi.advanceTimersByTime(5_000);
    expect(counter()).toBeNull();
    strip.dispose();
  });

  it('dispose stops the quiet tick (no counter update after disposal)', () => {
    let t = 1_000;
    const strip = createStatusStrip(el, () => t);
    strip.update(upd({ agentState: 'quiet', quietSince: 1_000 }));
    expect(counter()!.textContent).toBe(' for 0s');
    strip.dispose();
    t = 5_000;
    vi.advanceTimersByTime(4_000);
    expect(counter()!.textContent).toBe(' for 0s'); // frozen — the tick was cleared
  });
});
