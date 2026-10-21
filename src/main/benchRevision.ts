// #180 — a run's two revisions: the flow-definition revision and the prompt revision (the ticket's Definitions).

import type { BundleLocation } from './bundleLocation';
import type { FlowDefinition } from './flow';
import type { BenchSpan } from '../shared/benchLaunch';

export interface PromptRevisionQuery {
  definition: FlowDefinition;
  span: BenchSpan;
  appBundle: BundleLocation;
  /** The user-config root loop defs resolve their operator tier under; none when null. */
  userConfigRoot: string | null;
  /** The working folder whose repo tier the loop defs resolve through. */
  repoDir: string;
}

export function flowDefinitionRevision(_flowText: string): string {
  return '';
}

export function promptRevision(_query: PromptRevisionQuery): string {
  return '';
}
