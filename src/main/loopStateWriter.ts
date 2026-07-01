// Writer for the agent-loop engine state (§26.6). §24.2.3 T2 made the app a read-only MIRROR of
// <repo>/.agent-loop/state.yaml; §26 makes the app the ENGINE, so it now WRITES the file. A write is
// whole-document and valid v4 — every field a v4 reader (the §24.2.3 mirror, the §25 audit, a future
// Go re-handoff) needs is present, defaulted where the app does not yet use it — so the app never emits
// a partial doc a v4 reader would reject. Written atomically (tmp + rename) like the §19.1 flow store.
//
// CLAUDE.md (no-gitignore-writes): this writes only state.yaml; it never creates or edits a .gitignore.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { isRecord } from './yamlRecord';
import type { CostResult } from '../shared/pricing';

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
  /** §26.6 gate write surface (L5) — applied OVER the merged prior doc so a gate transition's own writes
   *  win. Absent → the field keeps its preserved prior value. `clearPersonaState` resets persona_state to
   *  `{}` (every persona re-reviews after a request-changes). */
  phase2Active?: boolean;
  clearPersonaState?: boolean;
  terminated?: boolean;
  /** §26.8 stuck tracking — the running finding signature + consecutive-identical count, written each
   *  consolidate. Serialized as the engine's `impasse.{consecutive_identical,last_findings_sig}`. */
  impasse?: { consecutiveIdentical: number; lastFindingsSig: string };
  /** §26.5 skip-opt footprints — the fresh full persona_state snapshot (last-clean iteration + footprint
   *  per persona). Serialized as `persona_state.{persona}.{last_clean_iter,last_seen_plan_digest,
   *  last_seen_files}`. Mutually exclusive with `clearPersonaState` (which resets to `{}`). */
  personaState?: Record<string, { lastCleanIter: number; lastSeenPlanDigest: string; lastSeenFiles: string[] }>;
  /** §26.10 cost meter — the display-only per-iteration cost persisted at the iteration boundary. Serialized
   *  as `cost.{usd,unpriced}`. Absent → the prior doc's `cost` is preserved by the merge (the strip keeps
   *  showing the last recorded cost). */
  cost?: CostResult;
}

const STATE_REL = path.join('.agent-loop', 'state.yaml');

/** The LoopExtension defaults for a brand-new doc (§26.6): empty maps/lists, false flags, zero counters.
 *  `auto_chain: true` mirrors the engine's pickup stub (writeBoundLoopStub). Used only when no prior
 *  state.yaml exists — an existing doc's own values are preserved instead (see writeLoopState). */
function defaultExtension(): Record<string, unknown> {
  return {
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
  };
}

/** The prior whole document, or null when absent/unreadable/non-mapping (best-effort, never throws). */
function readPriorDoc(file: string): Record<string, unknown> | null {
  try {
    const doc = yaml.load(readFileSync(file, 'utf8'));
    return isRecord(doc) ? doc : null;
  } catch {
    return null;
  }
}

/** Write <repoDir>/.agent-loop/state.yaml as a whole-document valid v4 doc (§26.6). `now` is injected
 *  for a deterministic `updated_at` (the clock seam). Atomic: a sibling .tmp is renamed into place. */
export function writeLoopState(repoDir: string, state: LoopStateWrite, now: () => Date = () => new Date()): void {
  const file = path.join(repoDir, STATE_REL);
  mkdirSync(path.dirname(file), { recursive: true });

  // §26.6 — a write is whole-document valid v4 AND preserves by merge. Layer, low to high: the
  // LoopExtension defaults (so a missing field is back-filled even when a partial prior doc exists), then
  // the prior whole document (so engine-owned fields a prior writer left — persona_state §26.5, impasse
  // §26.8 — survive a status-only write the app does not yet model), then the app-owned read set, emitted
  // uniformly present (defaulted, never conditionally omitted — the §26.6 reader must not see a partial
  // read set; that is why `pr`/`branch`/`linked_issues` all default rather than drop).
  const doc: Record<string, unknown> = {
    ...defaultExtension(),
    ...(readPriorDoc(file) ?? {}),
    schema_version: 4,
    pr: state.pr ?? 0,
    branch: state.branch ?? null,
    iteration: state.iteration,
    status: state.status,
    ...(state.boundLoop ? { bound_loop: state.boundLoop } : {}),
    linked_issues: state.linkedIssues,
    updated_at: now().toISOString(),
  };

  // §26.6 gate write surface (L5) — layered ABOVE the app read set so a gate transition's own writes win
  // over the preserved prior values; an absent field keeps its merged prior value.
  if (state.phase2Active !== undefined) doc.phase2_active = state.phase2Active;
  if (state.clearPersonaState) doc.persona_state = {};
  if (state.terminated !== undefined) doc.terminated = state.terminated;
  if (state.impasse !== undefined) {
    doc.impasse = { consecutive_identical: state.impasse.consecutiveIdentical, last_findings_sig: state.impasse.lastFindingsSig };
  }
  if (state.personaState !== undefined) {
    const out: Record<string, unknown> = {};
    for (const [persona, e] of Object.entries(state.personaState)) {
      out[persona] = { last_clean_iter: e.lastCleanIter, last_seen_plan_digest: e.lastSeenPlanDigest, last_seen_files: e.lastSeenFiles };
    }
    doc.persona_state = out;
  }
  if (state.cost !== undefined) {
    doc.cost = { usd: state.cost.usd, unpriced: state.cost.unpricedModels };
  }

  const tmp = `${file}.tmp`;
  writeFileSync(tmp, yaml.dump(doc));
  renameSync(tmp, file);
}
