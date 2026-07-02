// Reader for the orchestrator-owned engine-extension fields of .agent-loop/state.yaml (§26.6). The
// §24.2.3 mirror slice (agentLoopBridge.ts) stays the read-only public contract; this reads back the
// LARGER surface the orchestrator itself writes (loopStateWriter.ts) — phase2_active (§26.6) — so the
// two live beside their writer's field vocabulary and cannot drift. Like every state reader it degrades
// each missing/ill-typed field to a safe default and never throws on a foreign or partial doc.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { isRecord } from './yamlRecord';
import type { CostResult } from '../shared/pricing';

const STATE_REL = path.join('.agent-loop', 'state.yaml');

/** The orchestrator-owned extension the §26.6/§26.8 branch logic reads back from state.yaml. */
export interface LoopExtension {
  /** `phase2_active` (§26.6): request-changes activated the triage-routing mode. */
  phase2Active: boolean;
  /** `impasse` (§26.8): the running finding signature + consecutive-identical count the stuck detector
   *  advances each consolidate. */
  impasse: { consecutiveIdentical: number; lastFindingsSig: string };
  /** `persona_state` (§26.5): each persona's last-clean iteration + skip footprint. {} when absent. */
  personaState: Record<string, { lastCleanIter: number; lastSeenPlanDigest: string; lastSeenFiles: string[] }>;
  /** `cost` (§26.10): the last recorded display-only cost (priced dollars + unpriced ids). Null until an
   *  iteration boundary records one. */
  cost: CostResult | null;
  /** `bound_loop` (§26.11): which LoopDef governs the run — resume reads it to re-drive the right loop.
   *  "" when absent. */
  boundLoop: string;
  /** `epic.sub_issues` (§26.9): the sub-issue numbers epic-promote already created — a non-empty list
   *  means the epic was promoted, so a re-entered gate skips re-creating them (idempotency). [] when absent. */
  epic: { subIssues: number[] };
}

const DEFAULT_EXTENSION: LoopExtension = {
  phase2Active: false,
  impasse: { consecutiveIdentical: 0, lastFindingsSig: '' },
  personaState: {},
  cost: null,
  boundLoop: '',
  epic: { subIssues: [] },
};

/** Read the §26.6/§26.8 engine-extension slice from <repoDir>/.agent-loop/state.yaml, defaulting every
 *  field a missing / corrupt / ill-typed doc omits (never throws). */
export function readLoopExtension(repoDir: string): LoopExtension {
  let doc: unknown;
  try {
    doc = yaml.load(readFileSync(path.join(repoDir, STATE_REL), 'utf8'));
  } catch {
    return DEFAULT_EXTENSION;
  }
  if (!isRecord(doc)) return DEFAULT_EXTENSION;
  const imp = isRecord(doc.impasse) ? doc.impasse : {};
  const personaState: LoopExtension['personaState'] = {};
  if (isRecord(doc.persona_state)) {
    for (const [persona, e] of Object.entries(doc.persona_state)) {
      if (!isRecord(e)) continue;
      personaState[persona] = {
        lastCleanIter: typeof e.last_clean_iter === 'number' ? e.last_clean_iter : 0,
        lastSeenPlanDigest: typeof e.last_seen_plan_digest === 'string' ? e.last_seen_plan_digest : '',
        lastSeenFiles: Array.isArray(e.last_seen_files) ? e.last_seen_files.filter((f): f is string => typeof f === 'string') : [],
      };
    }
  }
  let cost: CostResult | null = null;
  if (isRecord(doc.cost) && typeof doc.cost.usd === 'number') {
    cost = {
      usd: doc.cost.usd,
      unpricedModels: Array.isArray(doc.cost.unpriced) ? doc.cost.unpriced.filter((s): s is string => typeof s === 'string') : [],
    };
  }
  return {
    phase2Active: doc.phase2_active === true,
    impasse: {
      consecutiveIdentical: typeof imp.consecutive_identical === 'number' ? imp.consecutive_identical : 0,
      lastFindingsSig: typeof imp.last_findings_sig === 'string' ? imp.last_findings_sig : '',
    },
    personaState,
    cost,
    boundLoop: typeof doc.bound_loop === 'string' ? doc.bound_loop : '',
    epic: {
      subIssues:
        isRecord(doc.epic) && Array.isArray(doc.epic.sub_issues)
          ? doc.epic.sub_issues.filter((n): n is number => typeof n === 'number')
          : [],
    },
  };
}
