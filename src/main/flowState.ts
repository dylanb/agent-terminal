// Flow-progression persistence (§19.1 / §24.2.2 S3). Each worktree owns one
// <worktree>/.agent-terminal/flow-state.yaml recording the current step and its status, so
// progression survives a relaunch. Writes are atomic (tmp + rename); a missing/corrupt file
// degrades to null (never a throw), mirroring the todoStore (§16.3).
//
// VCS (§19.1): flow-state.yaml is app-owned *progression*, gitignored by default — the entry is
// written on first use. This ignores only flow-state.yaml, not the committed flow.yaml (§18.1)
// or the user-owned todos.json (§16.3, whose committing is the user's choice).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { FlowStatus } from '../shared/ipc';

/** The persisted progression: which step is current and its lifecycle status (§19.1), plus the
 *  flow's resolved typed inputs (§18.4 / §24.2.3 T3) — kept flow-wide (not per-step) so a value
 *  resolved at one step threads to later steps' inputs (§18.1 output→input). */
export interface PersistedFlowState {
  step: string;
  status: FlowStatus;
  inputs?: Record<string, string>;
}

export interface FlowStateStore {
  /** The persisted progression, or null when absent/corrupt (never throws). */
  read(): PersistedFlowState | null;
  /** Persist progression atomically; gitignores flow-state.yaml on first use (§19.1). */
  write(state: PersistedFlowState): void;
}

const STATE_REL = path.join('.agent-terminal', 'flow-state.yaml');
const GITIGNORE_ENTRY = '.agent-terminal/flow-state.yaml';
const PERSISTABLE: ReadonlySet<FlowStatus> = new Set(['not_started', 'in_progress', 'done']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Read the persisted `inputs:` map, keeping only string→string entries; null when absent/empty so
 *  the round-trip omits the key entirely for a flow that resolved none (§24.2.3 T3). */
function readInputs(raw: unknown): Record<string, string> | null {
  if (!isRecord(raw)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') out[k] = v;
  return Object.keys(out).length > 0 ? out : null;
}

/** Append GITIGNORE_ENTRY to <dir>/.gitignore unless it is already ignored there (idempotent). */
function ensureGitignored(worktreeDir: string): void {
  const file = path.join(worktreeDir, '.gitignore');
  let existing = '';
  try {
    existing = readFileSync(file, 'utf8');
  } catch {
    existing = '';
  }
  if (existing.split('\n').some((l) => l.trim() === GITIGNORE_ENTRY)) return;
  const prefix = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`;
  writeFileSync(file, `${prefix}${GITIGNORE_ENTRY}\n`);
}

export function createFlowStateStore(worktreeDir: string): FlowStateStore {
  const file = path.join(worktreeDir, STATE_REL);
  return {
    read() {
      let doc: unknown;
      try {
        doc = yaml.load(readFileSync(file, 'utf8'));
      } catch {
        return null; // missing or unparseable → no progression (§19.1)
      }
      if (!isRecord(doc) || typeof doc.step !== 'string' || doc.step.length === 0) return null;
      if (typeof doc.status !== 'string' || !PERSISTABLE.has(doc.status as FlowStatus)) return null;
      const inputs = readInputs(doc.inputs);
      return { step: doc.step, status: doc.status as FlowStatus, ...(inputs ? { inputs } : {}) };
    },
    write(state) {
      mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      const hasInputs = state.inputs && Object.keys(state.inputs).length > 0;
      writeFileSync(tmp, yaml.dump({ step: state.step, status: state.status, ...(hasInputs ? { inputs: state.inputs } : {}) }));
      renameSync(tmp, file);
      ensureGitignored(worktreeDir);
    },
  };
}
