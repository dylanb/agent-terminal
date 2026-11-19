import type { FlowCatalogEntry, FlowCatalogSelection } from './ipc';

export function flowPickerEntry(entry: FlowCatalogEntry): { key: string; name: string } {
  return entry.available ? { key: entry.id, name: entry.id } : { key: entry.label, name: entry.label };
}

export function flowPickerSelected(selection: FlowCatalogSelection): string | null {
  return selection.kind === 'value' ? selection.id : null;
}
