import type { ActiveFlowWriteResult, FlowCatalogListResult, FlowStateView } from '../../shared/ipc';

export interface FlowPickerDeps {
  onView(cb: (repoKey: string | null, view: FlowStateView | null) => void): () => void;
  listCatalog(repoKey: string): Promise<FlowCatalogListResult>;
  select(repoKey: string, id: string): Promise<ActiveFlowWriteResult>;
  clearSelection(repoKey: string): Promise<ActiveFlowWriteResult>;
}

export interface FlowPicker {
  refresh(): void;
  dispose(): void;
}

export function createFlowPicker(_host: HTMLElement, _deps: FlowPickerDeps): FlowPicker {
  return { refresh() {}, dispose() {} };
}
