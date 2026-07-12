// Flow-progression persistence (§19.1 / §24.2.2 S3). The app NEVER modifies the user's .gitignore
// (no-gitignore-writes rule); a user who does not want flow-state.yaml committed ignores
// .agent-terminal/ themselves.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { atomicWriteFileSync } from './atomicFile';
import type { FlowStatus } from '../shared/ipc';
import { isRecord } from './yamlRecord';

/** Persisted progression (§19.1). `inputs` is flow-wide, not per-step, so a value resolved at one
 *  step threads to later steps' inputs (§18.1 output→input; §18.4 / §24.2.3 T3). */
export interface PersistedFlowState {
  step: string;
  status: FlowStatus;
  inputs?: Record<string, string>;
  /** Epoch ms at which this run of the flow began (§26.10) — the lower bound the cost meter sweeps
   *  session logs from. Absent for a flow that never started, and for one persisted before this field. */
  startedAt?: number;
  /** The name the user gave this worktree's work (§22.3). Absent until they name one. */
  title?: string;
}

export interface FlowStateStore {
  /** The persisted progression, or null when absent/corrupt (never throws). */
  read(): PersistedFlowState | null;
  /** Persist progression atomically (§19.1). */
  write(state: PersistedFlowState): void;
}

const STATE_REL = path.join('.agent-terminal', 'flow-state.yaml');
const PERSISTABLE: ReadonlySet<FlowStatus> = new Set(['not_started', 'in_progress', 'done']);

/** Null when absent/empty, so the round-trip omits the key for a flow that resolved none (§24.2.3 T3). */
function readInputs(raw: unknown): Record<string, string> | null {
  if (!isRecord(raw)) return null;
  // Null-prototype map: a YAML-supplied key like `__proto__` must store as own data, not hit the
  // prototype setter (prototype-pollution / data-loss vector).
  const out: Record<string, string> = Object.create(null);
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') out[k] = v;
  return Object.keys(out).length > 0 ? out : null;
}

/** Null unless the value is a real instant: an ill-typed or non-positive `started_at` would hand the cost
 *  meter a run window that never happened, so it degrades to "no recorded start" (§26.10). */
function readStartedAt(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
}

/** Null unless the value names something: a blank or ill-typed `title` would render the status bar's
 *  name slot as an empty, un-nameable gap rather than its click-to-name placeholder (§22.3). */
function readTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  return text.length > 0 ? text : null;
}

export function createFlowStateStore(worktreeDir: string): FlowStateStore {
  const file = path.join(worktreeDir, STATE_REL);
  return {
    read() {
      let doc: unknown;
      try {
        doc = yaml.load(readFileSync(file, 'utf8'));
      } catch {
        return null;
      }
      if (!isRecord(doc) || typeof doc.step !== 'string' || doc.step.length === 0) return null;
      if (typeof doc.status !== 'string' || !PERSISTABLE.has(doc.status as FlowStatus)) return null;
      const inputs = readInputs(doc.inputs);
      const startedAt = readStartedAt(doc.started_at);
      const title = readTitle(doc.title);
      return {
        step: doc.step,
        status: doc.status as FlowStatus,
        ...(inputs ? { inputs } : {}),
        ...(startedAt !== null ? { startedAt } : {}),
        ...(title !== null ? { title } : {}),
      };
    },
    write(state) {
      const hasInputs = state.inputs && Object.keys(state.inputs).length > 0;
      const title = readTitle(state.title);
      atomicWriteFileSync(
        file,
        yaml.dump({
          step: state.step,
          status: state.status,
          ...(hasInputs ? { inputs: state.inputs } : {}),
          ...(state.startedAt !== undefined ? { started_at: state.startedAt } : {}),
          ...(title !== null ? { title } : {}),
        }),
      );
    },
  };
}
