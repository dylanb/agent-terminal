// STUB (RED): §27 work-turn pure helpers. Filled in the GREEN commit.

import type { BoundaryPolicy, LoopDefV2 } from './loopDefV2';

export function boundaryCommand(_policy: BoundaryPolicy): string {
  return '';
}

export function completionArtifact(_def: LoopDefV2): { path: string } | null {
  return null;
}

export function completionMarker(_stepId: string): string {
  return '';
}

export function artifactWellFormed(_content: string | null, _marker: string): boolean {
  return false;
}

export interface AppWorkPromptReq {
  recipeBody: string;
  turnKey: string;
  doneRelPath: string;
  completion: { artifactRel: string; marker: string } | null;
}

export function composeAppWorkPrompt(_req: AppWorkPromptReq): string {
  return '';
}
