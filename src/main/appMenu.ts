// Application menu (§7.6/§7.7). On macOS the default Edit menu's ⌘C/⌘V/⌘A accelerators preempt the
// renderer and operate on xterm's *hidden native* selection — so terminal copy/paste/select-all
// silently do nothing. The darwin menu keeps the standard chrome but routes those three items to OUR
// renderer actions (the app-owned selection §7 + the §9.3-sanitized paste); the renderer decides
// terminal-vs-input by focus. Off darwin the renderer keymap (§7.5) owns those chords, so no Edit
// routing is needed — but a MINIMAL menu is still installed (see applyApplicationMenu) to replace
// Electron's default, whose View→Reset-Zoom binds ⌘0 (reserved for openSettings §7.7), while keeping
// keyboard zoom (WCAG 1.4.4) and fullscreen.

import type { BrowserWindow, Menu, MenuItemConstructorOptions } from 'electron';
import type { EditAction } from '../shared/ipc';

/** The slice of Electron's `Menu` static that installs the application menu. */
interface MenuApi {
  setApplicationMenu(menu: Menu | null): void;
  buildFromTemplate(template: MenuItemConstructorOptions[]): Menu;
}

/** Install the application menu for this platform. Setting ANY menu replaces Electron's default menu
 *  (whose View→Reset-Zoom binds ⌘0/Ctrl+0, reserved for openSettings §7.7), so both the darwin menu
 *  and the minimal off-darwin menu free the app-nav chords while keeping keyboard zoom (WCAG 1.4.4). */
export function applyApplicationMenu(template: MenuItemConstructorOptions[], menu: MenuApi): void {
  menu.setApplicationMenu(menu.buildFromTemplate(template));
}

// Keyboard zoom + fullscreen, shared by every platform's View menu. "Actual Size" is a plain item, not
// the `resetZoom` role: that role (and `viewMenu`) binds ⌘0, which §7.7 reserves for openSettings — a
// menu accelerator preempts the renderer, so the role would reset zoom instead of opening Settings.
// Zoom in/out keep their ⌘+/⌘- roles (no collision with the digit chords).
function zoomAndFullscreen(): MenuItemConstructorOptions[] {
  return [
    { label: 'Actual Size', click: (_item, win) => (win as BrowserWindow | undefined)?.webContents.setZoomLevel(0) },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' },
  ];
}

export function buildMenuTemplate(
  platform: NodeJS.Platform,
  onEdit: (action: EditAction) => void,
): MenuItemConstructorOptions[] {
  // Off darwin: a minimal menu — keyboard zoom + fullscreen only. It replaces Electron's default menu
  // (freeing ⌘0/Ctrl+0 for openSettings) and carries no native Edit roles, so the renderer keeps the
  // §9.3-sanitized copy/paste (§7.6).
  if (platform !== 'darwin') return [{ label: 'View', submenu: zoomAndFullscreen() }];

  const editItem = (label: string, accelerator: string, action: EditAction): MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: () => onEdit(action),
  });
  return [
    { role: 'appMenu' },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        editItem('Copy', 'Cmd+C', 'copy'),
        editItem('Paste', 'Cmd+V', 'paste'),
        editItem('Select All', 'Cmd+A', 'selectAll'),
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        ...zoomAndFullscreen(),
      ],
    },
    { role: 'windowMenu' },
  ];
}
