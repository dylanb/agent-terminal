// Flow-progression persistence (§19.1 / §24.2.2 S3). The app NEVER modifies the user's .gitignore
// (no-gitignore-writes rule); a user who does not want flow-state.yaml committed ignores
// .agent-terminal/ themselves.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { FlowStatus } from '../shared/ipc';
import { isRecord } from './yamlRecord';

/** Persisted progression (§19.1). `inputs` is flow-wide, not per-step, so a value resolved at one
 *  step threads to later steps' inputs (§18.1 output→input; §18.4 / §24.2.3 T3). */
export interface PersistedFlowState {
  step: string;
  status: FlowStatus;
  inputs?: Record<string, string>;
  /** The agent-loop signature dismissed by the last terminate/restart (§24.2.3 T7); the flow keeps the
   *  ticket/PR display cleared while the live loop still matches it, so the suppression survives a
   *  relaunch. Absent when no loop has been dismissed. */
  dismissedLoop?: string;
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
      const dismissedLoop = typeof doc.dismissedLoop === 'string' ? doc.dismissedLoop : null;
      return {
        step: doc.step,
        status: doc.status as FlowStatus,
        ...(inputs ? { inputs } : {}),
        ...(dismissedLoop !== null ? { dismissedLoop } : {}),
      };
    },
    write(state) {
      mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      const hasInputs = state.inputs && Object.keys(state.inputs).length > 0;
      writeFileSync(
        tmp,
        yaml.dump({
          step: state.step,
          status: state.status,
          ...(hasInputs ? { inputs: state.inputs } : {}),
          ...(state.dismissedLoop !== undefined ? { dismissedLoop: state.dismissedLoop } : {}),
        }),
      );
      renameSync(tmp, file);
    },
  };
}
