// macOS application menu (§7.7). With no app menu, macOS shows a default Edit menu whose ⌘C/⌘V/⌘A
// accelerators preempt the renderer and operate on xterm's *hidden native* selection — so terminal
// copy/paste/select-all silently do nothing. This menu keeps the standard chrome but routes those
// three items to OUR renderer actions (the app-owned selection §7 + the §9.3-sanitized paste); the
// renderer decides terminal-vs-input by focus. Off darwin there is no such conflict, so we add no
// menu and the renderer keymap (§7.5) owns the chords directly.

import type { MenuItemConstructorOptions } from 'electron';
import type { EditAction } from '../shared/ipc';

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
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
}
