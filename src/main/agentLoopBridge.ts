// Read-only bridge to the agent-loop engine state (§24.2.3 T2 / §17.2 / §19.1). The app MIRRORS
// the real v4 <repo>/.agent-loop/state.yaml — it never writes it; the human drives every agent-loop
// command by hand. Parsing degrades to null on anything it can't trust (unknown schema_version,
// corrupt, missing), exactly like the §19.1 flow-state store — a bad/foreign state.yaml can never
// crash the host or be misread as real progress.

import { readFileSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const STATE_REL = path.join('.agent-loop', 'state.yaml');

/** The slice of v4 state.yaml the flow surfaces (§24.2.3 T2). `status` carries the state machine;
 *  "needs you" is the explicit `awaiting-*` family. `pr`/`branch` are null before a loop has a PR. */
export interface AgentLoopState {
  status: string;
  iteration: number;
  pr: number | null;
  branch: string | null;
}

// Compared by VALUE, not YAML scalar type: state.yaml writes a bare `4`, LoopDefs a quoted `"4"`
// (loopDef.ts). The same coercing guard works for either engine file.
const SCHEMA_VERSION = '4';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Read & validate <repoDir>/.agent-loop/state.yaml. Returns the mirrored slice, or null for any
 *  missing / unknown-version / corrupt / ill-typed file (never throws). */
export function parseAgentLoopState(repoDir: string): AgentLoopState | null {
  let raw: string;
  try {
    raw = readFileSync(path.join(repoDir, STATE_REL), 'utf8');
  } catch {
    return null;
  }
  let doc: unknown;
  try {
    doc = yaml.load(raw);
  } catch {
    return null;
  }
  if (!isRecord(doc)) return null;
  if (String(doc.schema_version) !== SCHEMA_VERSION) return null;
  if (typeof doc.status !== 'string' || doc.status.length === 0) return null;
  if (typeof doc.iteration !== 'number') return null;
  return {
    status: doc.status,
    iteration: doc.iteration,
    pr: typeof doc.pr === 'number' ? doc.pr : null,
    branch: typeof doc.branch === 'string' ? doc.branch : null,
  };
}

/** Watch <repoDir>/.agent-loop/state.yaml for changes, calling `onChange` on each. Watches the
 *  containing directory (so an atomic rename-replace is caught), filtering to state.yaml. Returns
 *  an unsubscribe; if the directory can't be watched (e.g. it doesn't exist yet) it is a no-op. */
export function watchAgentLoopState(repoDir: string, onChange: () => void): () => void {
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(path.join(repoDir, '.agent-loop'), (_event, filename) => {
      // Some platforms report a null filename; treat that (and a state.yaml event) as a change.
      if (filename === null || filename === 'state.yaml') onChange();
    });
  } catch {
    return () => {};
  }
  return () => watcher?.close();
}
