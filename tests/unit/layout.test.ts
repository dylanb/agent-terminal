// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ARROW_STEP_RATIO,
  DEFAULT_SPLIT_RATIO,
  MIN_MONITOR_PX,
  MIN_TERMINAL_PX,
  wireLayout,
} from '../../src/renderer/src/layout';
import type { UiSettings } from '../../src/shared/ipc';

const flush = () => new Promise((r) => setTimeout(r, 0));
const W = 1000; // mocked container width

function makeSettings(splitRatio = DEFAULT_SPLIT_RATIO) {
  const state: UiSettings = { splitRatio, lastTab: 'capture', theme: 'light' };
  return {
    state,
    getSettings: vi.fn(async (): Promise<UiSettings> => ({ ...state })),
    setSettings: vi.fn((patch: Partial<UiSettings>) => Object.assign(state, patch)),
  };
}

function mountDom(): void {
  document.body.innerHTML = `
    <div id="app">
      <main id="terminal-pane"></main>
      <div id="splitter" role="separator" tabindex="0"></div>
      <aside id="monitor"></aside>
    </div>`;
  const app = document.getElementById('app')!;
  app.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: W, bottom: 600, width: W, height: 600, x: 0, y: 0, toJSON() {} }) as DOMRect;
}

const terminalPane = () => document.getElementById('terminal-pane') as HTMLElement;
const splitter = () => document.getElementById('splitter') as HTMLElement;
const termPct = () => parseFloat(terminalPane().style.flexBasis);
const valuenow = () => Number(splitter().getAttribute('aria-valuenow'));

function drag(clientX: number): void {
  splitter().dispatchEvent(new MouseEvent('pointerdown', { clientX: 0, bubbles: true }));
  window.dispatchEvent(new MouseEvent('pointermove', { clientX }));
}
function release(): void {
  window.dispatchEvent(new MouseEvent('pointerup', {}));
}

describe('resizable splitter & ratio persistence (§16.6)', () => {
  let dispose: (() => void) | undefined;

  beforeEach(() => mountDom());
  afterEach(() => {
    dispose?.();
    dispose = undefined;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('applies the stored split ratio to the terminal pane on init', async () => {
    const settings = makeSettings(0.4);
    dispose = wireLayout(settings);
    await flush();
    expect(termPct()).toBeCloseTo(40);
    expect(valuenow()).toBe(40);
  });

  it('drag rebalances the panes proportionally and persists only on release', async () => {
    const settings = makeSettings(0.65);
    dispose = wireLayout(settings);
    await flush();

    drag(500);
    expect(termPct()).toBeCloseTo(50);
    expect(settings.setSettings).not.toHaveBeenCalled(); // mid-drag does not spam persistence

    release();
    expect(settings.setSettings).toHaveBeenCalledWith({ splitRatio: 0.5 });
  });

  it('clamps the ratio at both panes’ minimum widths', async () => {
    const settings = makeSettings(0.5);
    dispose = wireLayout(settings);
    await flush();

    drag(5); // would shrink the terminal below its min
    expect(termPct()).toBeCloseTo((MIN_TERMINAL_PX / W) * 100);

    drag(995); // would shrink the monitor below its min
    expect(termPct()).toBeCloseTo((1 - MIN_MONITOR_PX / W) * 100);
  });

  it('double-click resets to the default ratio and persists it', async () => {
    const settings = makeSettings(0.4);
    dispose = wireLayout(settings);
    await flush();
    expect(termPct()).toBeCloseTo(40);

    splitter().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(termPct()).toBeCloseTo(DEFAULT_SPLIT_RATIO * 100);
    expect(settings.setSettings).toHaveBeenCalledWith({ splitRatio: DEFAULT_SPLIT_RATIO });
  });

  it('arrow keys nudge a focused separator and persist (keyboard a11y)', async () => {
    const settings = makeSettings(0.5);
    dispose = wireLayout(settings);
    await flush();

    splitter().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(termPct()).toBeCloseTo((0.5 - ARROW_STEP_RATIO) * 100);
    expect(valuenow()).toBe(Math.round((0.5 - ARROW_STEP_RATIO) * 100));
    expect(settings.setSettings).toHaveBeenLastCalledWith({ splitRatio: 0.5 - ARROW_STEP_RATIO });

    splitter().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(termPct()).toBeCloseTo(0.5 * 100);
  });

  it('exposes the clamp bounds as aria-valuemin/valuemax for the separator', async () => {
    const settings = makeSettings(0.5);
    dispose = wireLayout(settings);
    await flush();
    expect(Number(splitter().getAttribute('aria-valuemin'))).toBe(Math.round((MIN_TERMINAL_PX / W) * 100));
    expect(Number(splitter().getAttribute('aria-valuemax'))).toBe(
      Math.round((1 - MIN_MONITOR_PX / W) * 100),
    );
  });

  it('notifies the terminal to refit (window resize) when the layout changes', async () => {
    // The terminal pane fits xterm to its width on window resize; if the splitter
    // changes flex-basis without a resize, the xterm canvas overflows the shrunken
    // pane and overlaps the monitor. So a layout change must dispatch a resize.
    const settings = makeSettings(0.5);
    let resizes = 0;
    const onResize = () => resizes++;
    window.addEventListener('resize', onResize);
    try {
      dispose = wireLayout(settings);
      await flush();
      expect(resizes).toBeGreaterThan(0); // applied the stored ratio → refit

      const before = resizes;
      drag(450);
      expect(resizes).toBeGreaterThan(before); // drag rebalanced → refit
    } finally {
      window.removeEventListener('resize', onResize);
    }
  });

  it('round-trips a dragged ratio through settings and restores it on reload', async () => {
    const settings = makeSettings(0.65);
    dispose = wireLayout(settings);
    await flush();
    drag(450);
    release();
    expect(settings.setSettings).toHaveBeenCalledWith({ splitRatio: 0.45 });

    // Simulate an app restart: fresh DOM, fresh wiring, same persisted settings.
    dispose();
    mountDom();
    dispose = wireLayout(settings);
    await flush();
    expect(termPct()).toBeCloseTo(45);
  });
});
