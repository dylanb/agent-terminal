import type { FlowCatalogEntry, FlowCatalogSelection } from './ipc';

/** How the flow picker lists a catalog entry: its key and the name it shows. */
export function flowPickerEntry(entry: FlowCatalogEntry): { key: string; name: string } {
  return entry.available ? { key: entry.id, name: entry.id } : { key: entry.label, name: entry.label };
}

/** The catalog flow the picker shows as selected, or null when it runs the default. */
export function flowPickerSelected(selection: FlowCatalogSelection): string | null {
  return selection.kind === 'value' ? selection.id : null;
}
