import { describe, it, expect, vi } from 'vitest';
import { buildMenuTemplate } from '../../src/main/appMenu';
import type { MenuItemConstructorOptions } from 'electron';

// The macOS application menu (§7.7): Copy/Paste/Select All route to OUR actions (the app-owned
// selection + sanitized paste) instead of the default roles, which would act on xterm's hidden native
// selection. Off darwin the default menu has no ⌘C/⌘V conflict, so the builder returns null.
function find(items: MenuItemConstructorOptions[] | null | undefined, label: string): MenuItemConstructorOptions {
  const hit = (items ?? []).find((i) => i.label === label);
  if (!hit) throw new Error(`menu item not found: ${label}`);
  return hit;
}

describe('appMenu (§7.7)', () => {
  it('returns null off macOS (the renderer keymap owns the chords there)', () => {
    expect(buildMenuTemplate('linux', vi.fn())).toBeNull();
    expect(buildMenuTemplate('win32', vi.fn())).toBeNull();
  });

  it('on macOS routes Copy/Paste/Select All to the injected edit handler with ⌘ accelerators', () => {
    const onEdit = vi.fn();
    const template = buildMenuTemplate('darwin', onEdit);
    const edit = find(template, 'Edit').submenu as MenuItemConstructorOptions[];

    for (const [label, action, accel] of [
      ['Copy', 'copy', 'Cmd+C'],
      ['Paste', 'paste', 'Cmd+V'],
      ['Select All', 'selectAll', 'Cmd+A'],
    ] as const) {
      const item = find(edit, label);
      expect(item.accelerator).toBe(accel);
      (item.click as () => void)();
      expect(onEdit).toHaveBeenLastCalledWith(action);
    }
  });
});
