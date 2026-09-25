import type { FlowStateView } from '../../shared/ipc';

export type FlowViewArgs = [repoKey: string, view: FlowStateView] | [repoKey: null, view: null];
