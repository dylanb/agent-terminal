import { describe, it, expect, vi } from 'vitest';
import { buildMenuTemplate, applyApplicationMenu } from '../../src/main/appMenu';
import { MAC_DEFAULTS, type Chord } from '../../src/shared/keymap';
import type { Menu, MenuItemConstructorOptions } from 'electron';

// The macOS application menu (§7.7): Copy/Paste/Select All route to OUR actions (the app-owned
// selection + sanitized paste) instead of the default roles, which would act on xterm's hidden native
// selection. Off darwin the default menu has no ⌘C/⌘V conflict, so the builder returns null.
function find(items: MenuItemConstructorOptions[] | null | undefined, label: string): MenuItemConstructorOptions {
  const hit = (items ?? []).find((i) => i.label === label);
  if (!hit) throw new Error(`menu item not found: ${label}`);
  return hit;
}

function flatten(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((i) => [i, ...(Array.isArray(i.submenu) ? flatten(i.submenu) : [])]);
}

// A mac chord rendered as an Electron accelerator ('Cmd+0'), the form the Edit items above use.
function chordToAccel(c: Chord): string {
  const mods = [c.ctrl && 'Ctrl', c.alt && 'Alt', c.shift && 'Shift', c.meta && 'Cmd'].filter(Boolean);
  return [...mods, c.key.toUpperCase()].join('+');
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

  // §7.7: the renderer keymap owns the app-nav chords (openSettings ⌘0, toggleDrawer ⌘9). On macOS a
  // menu accelerator preempts the renderer keydown — the same preemption this file routes ⌘C/⌘V/⌘A
  // around — so any menu item claiming a reserved chord makes that chord dead on macOS, a regression
  // the Linux e2e cannot see (buildMenuTemplate returns null off darwin). Electron's `viewMenu` /
  // `resetZoom` roles bind ⌘0 ("Reset Zoom"), so the installed menu must delegate to neither.
  it('leaves the app-nav chords (⌘0/⌘9) unclaimed by any menu item', () => {
    const items = flatten(buildMenuTemplate('darwin', vi.fn()) as MenuItemConstructorOptions[]);
    const reserved = [MAC_DEFAULTS.openSettings, MAC_DEFAULTS.toggleDrawer].flat().map(chordToAccel);
    for (const item of items) {
      if (item.accelerator) expect(reserved).not.toContain(item.accelerator);
    }
    const roles = items.map((i) => i.role);
    expect(roles).not.toContain('viewMenu');
    expect(roles).not.toContain('resetZoom');
  });

  it('keeps a View menu whose Actual Size resets zoom without a (⌘0) accelerator', () => {
    const template = buildMenuTemplate('darwin', vi.fn());
    const view = find(template, 'View').submenu as MenuItemConstructorOptions[];
    const roles = view.map((i) => i.role);
    expect(roles).toContain('zoomIn');
    expect(roles).toContain('zoomOut');

    const actualSize = find(view, 'Actual Size');
    expect(actualSize.accelerator).toBeUndefined();
    const setZoomLevel = vi.fn();
    (actualSize.click as (i: unknown, w: unknown) => void)(null, { webContents: { setZoomLevel } });
    expect(setZoomLevel).toHaveBeenCalledWith(0);
  });
});

// §7.6: off darwin no menu is installed — the renderer keymap owns every chord. Electron's DEFAULT
// menu (kept if setApplicationMenu is never called) binds ⌘0/Ctrl+0 to "Reset Zoom", which would
// preempt the openSettings chord (§7.7) on Linux/Windows — both target platforms. So off darwin the
// app must actively CLEAR the default menu, not merely skip installing its own.
describe('applyApplicationMenu (§7.6)', () => {
  function fakeMenuApi() {
    const built = { tag: 'built-menu' } as unknown as Menu;
    return { built, setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn(() => built) };
  }

  it('off macOS clears the default menu so the renderer keymap owns the chords', () => {
    const api = fakeMenuApi();
    applyApplicationMenu(buildMenuTemplate('linux', vi.fn()), api);
    expect(api.buildFromTemplate).not.toHaveBeenCalled();
    expect(api.setApplicationMenu).toHaveBeenCalledWith(null);
  });

  it('on macOS installs the custom menu built from the template', () => {
    const api = fakeMenuApi();
    applyApplicationMenu(buildMenuTemplate('darwin', vi.fn()), api);
    expect(api.buildFromTemplate).toHaveBeenCalledTimes(1);
    expect(api.setApplicationMenu).toHaveBeenCalledWith(api.built);
  });
});
