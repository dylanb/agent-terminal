// Application menu (§7.7). On macOS the default Edit menu's ⌘C/⌘V/⌘A accelerators preempt the renderer
// and operate on xterm's *hidden native* selection — so terminal copy/paste/select-all silently do
// nothing. The darwin menu keeps the standard chrome but routes those three items to OUR renderer
// actions (the app-owned selection §7 + the §9.3-sanitized paste); the renderer decides
// terminal-vs-input by focus. Off darwin the renderer keymap (§7.5) owns those chords, so no Edit
// routing is needed — but a MINIMAL menu is still installed to replace Electron's default, whose
// View→Reset-Zoom binds ⌘0/Ctrl+0 (reserved for openSettings §7.7): a menu accelerator preempts the
// renderer, so leaving the default would make ⌘0 reset zoom instead of opening Settings. The minimal
// menu keeps keyboard zoom (WCAG 1.4.4) and fullscreen, which clearing the menu outright would drop.

import type { BrowserWindow, Menu, MenuItemConstructorOptions } from 'electron';
import type { EditAction } from '../shared/ipc';

/** The slice of Electron's `Menu` static that installs the application menu. */
interface MenuApi {
  setApplicationMenu(menu: Menu | null): void;
  buildFromTemplate(template: MenuItemConstructorOptions[]): Menu;
}

/** Install the platform's application menu. Setting any menu replaces Electron's default (see header). */
export function applyApplicationMenu(template: MenuItemConstructorOptions[], menu: MenuApi): void {
  menu.setApplicationMenu(menu.buildFromTemplate(template));
}

// Keyboard zoom + fullscreen, shared by every platform's View menu. "Actual Size" is a plain item, not
// the `resetZoom` role (nor `viewMenu`), because those bind ⌘0 — reserved for openSettings (see header).
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
  // Off darwin: a minimal menu — keyboard zoom + fullscreen only, no native Edit roles, so the renderer
  // keeps the §9.3-sanitized copy/paste (§7.7; see header for why it replaces the default menu).
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
