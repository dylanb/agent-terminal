import { describe, expect, it, vi } from 'vitest';
import {
  denyWindowOpen,
  installNavigationGuards,
  preventForeignNavigation,
} from '../../src/main/windowGuards';

describe('window navigation guards (Electron security checklist 13/14)', () => {
  it('denies all window-open requests', () => {
    expect(denyWindowOpen()).toEqual({ action: 'deny' });
  });

  it('cancels navigation away from the bundled renderer', () => {
    const event = { preventDefault: vi.fn() };
    preventForeignNavigation(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it('cancels both will-navigate and will-redirect, and denies window-open', () => {
    const handlers: Record<string, (e: { preventDefault(): void }) => void> = {};
    const setWindowOpenHandler = vi.fn();
    installNavigationGuards({
      on: (event, listener) => {
        handlers[event] = listener;
      },
      setWindowOpenHandler,
    });

    // A server-side redirect fires will-redirect, not will-navigate — both must cancel.
    for (const event of ['will-navigate', 'will-redirect']) {
      const navEvent = { preventDefault: vi.fn() };
      expect(handlers[event], `${event} handler registered`).toBeTypeOf('function');
      handlers[event]!(navEvent);
      expect(navEvent.preventDefault, event).toHaveBeenCalledOnce();
    }
    expect(setWindowOpenHandler).toHaveBeenCalledWith(denyWindowOpen);
  });
});
