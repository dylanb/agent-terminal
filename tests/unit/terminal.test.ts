// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { wireTerminalPaneListeners, RESIZE_DEBOUNCE_MS } from '../../src/renderer/src/terminal';
import { FOCUS_VIEW_EVENT } from '../../src/renderer/src/paneActions';

// §7.1 / UI-STANDARDS clean teardown — the terminal pane registers window-level listeners
// (focus-on-view + debounced resize) that must be removable on unmount/relocation. The xterm
// construction itself needs a real layout and is covered by the §F e2e (recorded gap); this unit
// pins the listener wiring + its disposer, the observable boundary of the teardown change.
describe('terminal pane listeners (§7.1 / clean teardown)', () => {
  afterEach(() => vi.useRealTimers());

  const fireFocus = (view: string): void =>
    void window.dispatchEvent(new CustomEvent(FOCUS_VIEW_EVENT, { detail: { view } }));

  it('focuses only when FOCUS_VIEW_EVENT targets the terminal view (1)', () => {
    const focusView = vi.fn();
    const dispose = wireTerminalPaneListeners({ focusView, resize: vi.fn() });
    fireFocus('2');
    expect(focusView).not.toHaveBeenCalled();
    fireFocus('1');
    expect(focusView).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('debounces resize and stops firing after dispose()', () => {
    vi.useFakeTimers();
    const resize = vi.fn();
    const dispose = wireTerminalPaneListeners({ focusView: vi.fn(), resize });
    window.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(RESIZE_DEBOUNCE_MS);
    expect(resize).toHaveBeenCalledTimes(1); // coalesced to one
    dispose();
    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(RESIZE_DEBOUNCE_MS);
    expect(resize).toHaveBeenCalledTimes(1); // no further fire after teardown
  });

  it('removes the focus-on-view listener on dispose()', () => {
    const focusView = vi.fn();
    const dispose = wireTerminalPaneListeners({ focusView, resize: vi.fn() });
    dispose();
    fireFocus('1');
    expect(focusView).not.toHaveBeenCalled();
  });
});
