// Read-only bridge to the agent-loop engine state (§24.2.3 T2 / §17.2 / §19.1). The app MIRRORS the
// real v4 <repo>/.agent-loop/state.yaml and MUST never write it; the human drives every agent-loop
// command by hand. Parsing degrades to null on anything it can't trust, so a bad/foreign state.yaml
// can never crash the host or be misread as real progress.

import { readFileSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { isRecord } from './yamlRecord';

const STATE_REL = path.join('.agent-loop', 'state.yaml');

/** The slice of v4 state.yaml the flow surfaces (§24.2.3 T2). `status` carries the state machine;
 *  "needs you" is the explicit `awaiting-*` family. `pr`/`branch` are null before a loop has a PR.
 *  `linkedIssues` are the GitHub issue numbers the loop is bound to (the ticket fallback when the
 *  flow input is unset); `[]` when absent. */
export interface AgentLoopState {
  status: string;
  iteration: number;
  pr: number | null;
  branch: string | null;
  linkedIssues: number[];
}

// Compared by VALUE, not YAML scalar type: state.yaml writes a bare `4`, LoopDefs a quoted `"4"`
// (loopDef.ts). The same coercing guard works for either engine file.
const SCHEMA_VERSION = '4';

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
    // The §26.6 writer serializes a null PR as the whole-document-valid `0`; decode it back (GitHub PR
    // numbers are >=1, so `0`/non-positive is the "no PR yet" sentinel, never a real ref).
    pr: typeof doc.pr === 'number' && doc.pr > 0 ? doc.pr : null,
    branch: typeof doc.branch === 'string' ? doc.branch : null,
    linkedIssues: Array.isArray(doc.linked_issues) ? doc.linked_issues.filter((n): n is number => typeof n === 'number') : [],
  };
}

/** True for a state.yaml fs.watch event. `filename` is `string | Buffer | null`: it is a Buffer on
 *  some platforms/encodings (a raw `===` against the string would miss it), and null on platforms
 *  that omit it — both must count, or a real edit would silently not fire onChange. */
export function isStateFileEvent(filename: string | Buffer | null): boolean {
  return filename === null || filename.toString() === 'state.yaml';
}

/** Watch <repoDir>/.agent-loop/state.yaml for changes, calling `onChange` on each. Watches the
 *  containing directory (so an atomic rename-replace is caught), filtering to state.yaml. Returns
 *  an unsubscribe, or NULL when the directory can't be watched yet (e.g. it doesn't exist) — the
 *  caller must not cache a null as a live watcher, so a later directory appearance can still attach. */
export function watchAgentLoopState(repoDir: string, onChange: () => void): (() => void) | null {
  let watcher: FSWatcher;
  try {
    watcher = watch(path.join(repoDir, '.agent-loop'), (_event, filename) => {
      if (isStateFileEvent(filename)) onChange();
    });
  } catch {
    return null;
  }
  return () => watcher.close();
}
