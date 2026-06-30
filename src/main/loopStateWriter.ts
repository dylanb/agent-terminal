// Writer for the agent-loop engine state (§26.6). §24.2.3 T2 made the app a read-only MIRROR of
// <repo>/.agent-loop/state.yaml; §26 makes the app the ENGINE, so it now WRITES the file. A write is
// whole-document and valid v4 — every field a v4 reader (the §24.2.3 mirror, the §25 audit, a future
// Go re-handoff) needs is present, defaulted where the app does not yet use it — so the app never emits
// a partial doc a v4 reader would reject. Written atomically (tmp + rename) like the §19.1 flow store.
//
// CLAUDE.md (no-gitignore-writes): this writes only state.yaml; it never creates or edits a .gitignore.

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

/** The state the orchestrator persists. The L1 bootstrap supplies the read set (§24.2.3) plus the
 *  bound LoopDef; later slices supply the rest of the §26.6 surface, which defaults here until then. */
export interface LoopStateWrite {
  status: string;
  iteration: number;
  /** Null before a PR exists; serialized as the engine's `0` so the doc stays whole-document valid v4. */
  pr: number | null;
  branch: string | null;
  boundLoop: string;
  linkedIssues: number[];
}

const STATE_REL = path.join('.agent-loop', 'state.yaml');

/** Write <repoDir>/.agent-loop/state.yaml as a whole-document valid v4 doc (§26.6). `now` is injected
 *  for a deterministic `updated_at` (the clock seam). Atomic: a sibling .tmp is renamed into place. */
export function writeLoopState(repoDir: string, state: LoopStateWrite, now: () => Date = () => new Date()): void {
  const file = path.join(repoDir, STATE_REL);
  mkdirSync(path.dirname(file), { recursive: true });

  // The §26.6 write surface. The read set (schema_version/pr/branch/iteration/status) plus the
  // LoopExtension fields the orchestrator owns, defaulted: empty maps/lists, false flags, zero
  // counters. `auto_chain: true` mirrors the engine's pickup stub (writeBoundLoopStub).
  const doc: Record<string, unknown> = {
    schema_version: 4,
    pr: state.pr ?? 0,
    ...(state.branch ? { branch: state.branch } : {}),
    iteration: state.iteration,
    status: state.status,
    ...(state.boundLoop ? { bound_loop: state.boundLoop } : {}),
    ...(state.linkedIssues.length > 0 ? { linked_issues: state.linkedIssues } : {}),
    sessions: {},
    impasse: {},
    phase2_active: false,
    persona_state: {},
    severity_cycle_iter: 0,
    iter_in_flight: 0,
    resume_mid_iter: 0,
    auto_chain: true,
    human_notes: [],
    completed_loops: [],
    terminated: false,
    updated_at: now().toISOString(),
  };

  const tmp = `${file}.tmp`;
  writeFileSync(tmp, yaml.dump(doc));
  renameSync(tmp, file);
}
