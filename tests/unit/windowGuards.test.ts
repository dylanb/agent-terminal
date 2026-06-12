import { describe, expect, it, vi } from 'vitest';
import { denyWindowOpen, preventForeignNavigation } from '../../src/main/windowGuards';

describe('window navigation guards (Electron security checklist 13/14)', () => {
  it('denies all window-open requests', () => {
    expect(denyWindowOpen()).toEqual({ action: 'deny' });
  });

  it('cancels navigation away from the bundled renderer', () => {
    const event = { preventDefault: vi.fn() };
    preventForeignNavigation(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });
});
