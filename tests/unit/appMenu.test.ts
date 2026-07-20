import { describe, it, expect, vi } from 'vitest';
import { buildMenuTemplate, applyApplicationMenu } from '../../src/main/appMenu';
import { MAC_DEFAULTS, type Chord } from '../../src/shared/keymap';
import type { Menu, MenuItemConstructorOptions } from 'electron';

// The macOS application menu (§7.7): Copy/Paste/Select All route to OUR actions (the app-owned
// selection + sanitized paste) instead of the default roles, which would act on xterm's hidden native
// selection. Off darwin a minimal menu (keyboard zoom + fullscreen, no Edit routing) is installed —
// enough to keep text-resize (WCAG 1.4.4) while freeing the app-nav chords (§7.7).
function find(items: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions {
  const hit = items.find((i) => i.label === label);
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

  // §7.7: off darwin the renderer keymap owns the app-nav chords AND the §9.3-sanitized copy/paste, so
  // the off-darwin menu carries no Edit routing — but it must still expose keyboard zoom (Electron's
  // default menu was its only source), or a low-vision keyboard user loses text-resize (WCAG 1.4.4).
  it('off macOS installs a minimal View menu (keyboard zoom + fullscreen), no Edit routing', () => {
    for (const platform of ['linux', 'win32'] as const) {
      const template = buildMenuTemplate(platform, vi.fn());
      expect(template.some((i) => i.label === 'Edit')).toBe(false);
      const view = find(template, 'View').submenu as MenuItemConstructorOptions[];
      const roles = view.map((i) => i.role);
      expect(roles).toContain('zoomIn'); // Ctrl+= — text resize preserved (WCAG 1.4.4)
      expect(roles).toContain('zoomOut'); // Ctrl+-
      expect(roles).toContain('togglefullscreen');
    }
  });

  // §7.7: the renderer keymap owns the app-nav chords (openSettings ⌘0, toggleDrawer ⌘9). A menu
  // accelerator preempts the renderer keydown (on macOS, and via the default menu on Linux/Windows) —
  // the same preemption this file routes ⌘C/⌘V/⌘A around — so any menu item claiming a reserved chord
  // makes it dead, a regression the CDP-driven e2e cannot see. Electron's `viewMenu` / `resetZoom`
  // roles bind ⌘0 ("Reset Zoom"), so the installed menu (every platform) must delegate to neither.
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    it(`leaves the app-nav chords (⌘0/⌘9) unclaimed by any menu item (${platform})`, () => {
      const items = flatten(buildMenuTemplate(platform, vi.fn()));
      const reserved = [MAC_DEFAULTS.openSettings, MAC_DEFAULTS.toggleDrawer].flat().map(chordToAccel);
      for (const item of items) {
        if (item.accelerator) expect(reserved).not.toContain(item.accelerator);
      }
      const roles = items.map((i) => i.role);
      expect(roles).not.toContain('viewMenu');
      expect(roles).not.toContain('resetZoom');
    });
  }

  it('a View menu (both platforms) resets zoom via an "Actual Size" item without a ⌘0 accelerator', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const view = find(buildMenuTemplate(platform, vi.fn()), 'View').submenu as MenuItemConstructorOptions[];
      const actualSize = find(view, 'Actual Size');
      expect(actualSize.accelerator).toBeUndefined();
      const setZoomLevel = vi.fn();
      (actualSize.click as (i: unknown, w: unknown) => void)(null, { webContents: { setZoomLevel } });
      expect(setZoomLevel).toHaveBeenCalledWith(0);
    }
  });
});

// Setting ANY menu replaces Electron's default menu (whose View→Reset Zoom binds ⌘0/Ctrl+0, reserved
// for openSettings §7.7), so both the darwin and the minimal off-darwin menu free the app-nav chords.
describe('applyApplicationMenu (§7.7)', () => {
  function fakeMenuApi() {
    const built = { tag: 'built-menu' } as unknown as Menu;
    return { built, setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn(() => built) };
  }

  for (const platform of ['darwin', 'linux'] as const) {
    it(`installs the menu built from the platform template (${platform})`, () => {
      const api = fakeMenuApi();
      applyApplicationMenu(buildMenuTemplate(platform, vi.fn()), api);
      expect(api.buildFromTemplate).toHaveBeenCalledTimes(1);
      expect(api.setApplicationMenu).toHaveBeenCalledWith(api.built);
    });
  }
});
