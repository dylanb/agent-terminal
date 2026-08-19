// STUB (RED): surface present, parses/loads nothing yet.
export const LOOP_CAPABILITIES_FILENAME = 'loop-capabilities.yaml';

export interface LoopCapabilities {
  testGlobs: string[];
  testCommand: string;
  buildCommand: string;
  selectTemplate?: string;
}

export type LoopCapabilitiesParse =
  | { ok: true; value: LoopCapabilities }
  | { ok: false; reason: string };

export type LoopCapabilitiesLoad =
  | { ok: true; value: LoopCapabilities }
  | { ok: false; cause: 'absent' | 'malformed' | 'confinement'; reason: string };

export function parseLoopCapabilities(text: string): LoopCapabilitiesParse {
  void text;
  return { ok: false, reason: 'unimplemented' };
}

export function loadLoopCapabilities(repoDir: string): LoopCapabilitiesLoad {
  void repoDir;
  return { ok: false, cause: 'malformed', reason: 'unimplemented' };
}
