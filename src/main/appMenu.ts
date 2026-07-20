// macOS application menu (§7.7). With no app menu, macOS shows a default Edit menu whose ⌘C/⌘V/⌘A
// accelerators preempt the renderer and operate on xterm's *hidden native* selection — so terminal
// copy/paste/select-all silently do nothing. This menu keeps the standard chrome but routes those
// three items to OUR renderer actions (the app-owned selection §7 + the §9.3-sanitized paste); the
// renderer decides terminal-vs-input by focus. Off darwin no menu is installed (§7.6) and the
// renderer keymap (§7.5) owns the chords directly — see applyApplicationMenu.

import type { BrowserWindow, Menu, MenuItemConstructorOptions } from 'electron';
import type { EditAction } from '../shared/ipc';

/** The slice of Electron's `Menu` static that installs (or clears) the application menu. */
interface MenuApi {
  setApplicationMenu(menu: Menu | null): void;
  buildFromTemplate(template: MenuItemConstructorOptions[]): Menu;
}

/** Install the application menu for this platform: the custom darwin menu, or — off darwin — CLEAR
 *  the default menu so the renderer keymap owns every chord (§7.6). Passing `null` is load-bearing:
 *  Electron's default menu binds ⌘0/Ctrl+0 ("Reset Zoom"), which would preempt the openSettings chord
 *  (§7.7) on the Linux/Windows target platforms; merely skipping setApplicationMenu leaves it bound. */
export function applyApplicationMenu(template: MenuItemConstructorOptions[] | null, menu: MenuApi): void {
  menu.setApplicationMenu(template ? menu.buildFromTemplate(template) : null);
}

export function buildMenuTemplate(
  platform: NodeJS.Platform,
  onEdit: (action: EditAction) => void,
): MenuItemConstructorOptions[] | null {
  if (platform !== 'darwin') return null;
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
        // "Actual Size" is a plain item, not the `resetZoom` role: that role (and `viewMenu`) binds ⌘0,
        // which §7.7 reserves for openSettings — and on macOS a menu accelerator preempts the renderer,
        // so the role would make ⌘0 reset zoom instead of opening Settings. Zoom in/out keep ⌘+/⌘-.
        { label: 'Actual Size', click: (_item, win) => (win as BrowserWindow | undefined)?.webContents.setZoomLevel(0) },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
}
