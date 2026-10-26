// Deterministic worktree-state fixtures for A2 (#133) — the per-worktree active-flow resolution engine. The
// slice tests drive the started-ness matrix (§18.7.4) and the three-leg definition resolver (§18.7.3) against
// REAL on-disk states, so this single-sources the worktree shapes those tests seed rather than each slice
// re-spelling them. No wall-clock, randomness, or network: every file's bytes are fixed literals (mkdtemp's
// unique suffix aside, the standard hermetic-temp pattern gitRepo.ts uses).
//
// Paths are derived from the production resolvers so a fixture path and the code under test resolve the
// identical location (CLAUDE.md writer↔reader-location rule): the flow home from flow.ts's flowHomeDir +
// FLOW_DEF_FILE, and .agent-terminal (where flow-state.yaml is its sibling) from that same flowHomeDir. The
// flow-state leaf is re-spelled here because flowState.ts keeps STATE_REL private — the same acknowledged
// re-spelling loopArtifacts.ts makes for the identical file.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';
import { flowHomeDir, FLOW_DEF_FILE } from '../../src/main/flow';
import { recordDisposition, runDispositionFile } from '../../src/main/runDisposition';
import { activeFlowPointerFile } from '../../src/main/activeFlowPointer';
import type { DispositionRead } from '../../src/main/resolveRunDefinition';

const FLOW_STATE_FILE = 'flow-state.yaml';

/** The persistable subset of FlowStatus a progression record may carry (flowState.ts PERSISTABLE). */
export type PersistableStatus = 'not_started' | 'in_progress' | 'done';

/** A minimal §18.1 flow definition to seed: `stepIds` become `manual` steps so their ids are assertable. */
export interface FlowDefInput {
  name: string;
  stepIds: string[];
}

/** A progression record to seed as flow-state.yaml (the valid-record leg of the started-ness matrix). */
export interface FlowStateInput {
  step: string;
  status: PersistableStatus;
}

export interface WorktreeFixture {
  /** A worktree root with a real `.agent-terminal/` dir. */
  makeWorktree(prefix: string): string;
  /** A worktree root WITHOUT `.agent-terminal/` — the first-run-writer case (AC10 / the first-run lock pin). */
  makeFirstRunWorktree(prefix: string): string;
  /** A worktree path whose ROOT does not resolve — the anchor-unresolvable leg (resolveJail → null). The parent
   *  is tracked for cleanup; the worktree dir itself is never created, so `realpathSync` on it throws. */
  nonexistentWorktree(prefix: string): string;
  /** Seed `<dir>/.agent-terminal/flow.yaml` (leg-2 local, or leg-3 global fallback on a global root). */
  writeFlowHome(dir: string, def: FlowDefInput): string;
  /** Seed a valid progression at the flow-state path. */
  writeFlowState(dir: string, state: FlowStateInput): string;
  /** Seed exactly `contents` at the flow-state path — the title-only / corrupt / arbitrary legs. */
  writeFlowStateRaw(dir: string, contents: string): string;
  /** Seed a valid-in-schema progression padded past `byteLength` — the over-cap → indeterminate leg. */
  writeFlowStateOversized(dir: string, byteLength: number, base: FlowStateInput): string;
  /** Plant a symlink AT the flow-state path pointing to `target` — the leaf-symlink CWE-59 confinement-escape leg. */
  plantFlowStateEscape(dir: string, target: string): string;
  /** Plant `.agent-terminal` ITSELF as a symlink to `target` (a dir holding a real flow-state.yaml) — the
   *  intermediate-directory CWE-59 shape a leaf-only lstat misses (it resolves the parent symlink), so only
   *  whole-path resolution catches it; mirrors loopArtifacts.ts's plantAppStateParentSymlink. Requires no
   *  pre-existing `.agent-terminal` (use makeFirstRunWorktree). */
  plantAgentTerminalDirEscape(dir: string, target: string): string;
  /** A begun run's disposition + source binding. */
  writeRunRecord(dir: string, binding: DispositionRead): string;
  /** Seed exactly `contents` at the run-record path. Garbage reads as a present record with no binding — the
   *  AC13 held leg, not the AC17 indeterminate one. */
  writeRunRecordRaw(dir: string, contents: string): string;
  /** Replace the run record with a symlink to `target` — an AC13 held leg (unreadable by link), not an AC17
   *  indeterminate one, although A2's raw record-presence read calls it indeterminate. */
  plantRunRecordSymlink(dir: string, target: string): string;
  /** Replace the run record with a non-empty directory: a present record with no binding — an AC13 held leg. */
  plantRunRecordDirectory(dir: string): string;
  /** The record-missing leg. */
  removeRunRecord(dir: string): void;
  /** Replace whatever is at the active-flow pointer path with a non-empty directory, so the pointer write
   *  fails. Root-safe, unlike a chmod (a no-op as root under Podman). */
  plantPointerDirectory(dir: string): string;
  /** Seed exactly `raw` at the active-flow pointer path — hostile or arbitrary pointer text. */
  writePointer(dir: string, raw: string): string;
  /** A temp dir outside every worktree — the redirect target for escape planters and sentinel flows. */
  outsideDir(prefix: string): string;
  /** Remove every temp dir this fixture created. */
  cleanup(): void;
}

export function createWorktreeFixture(): WorktreeFixture {
  const tracked: string[] = [];

  const flowStateFile = (dir: string): string => join(flowHomeDir(dir), FLOW_STATE_FILE);
  const flowDefFile = (dir: string): string => join(flowHomeDir(dir), FLOW_DEF_FILE);

  const write = (file: string, contents: string): string => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
    return file;
  };

  const plantNonEmptyDir = (file: string): string => {
    rmSync(file, { recursive: true, force: true });
    mkdirSync(file, { recursive: true });
    writeFileSync(join(file, 'occupant'), 'occupies the path\n');
    return file;
  };

  const recordText = (state: FlowStateInput): string =>
    yaml.dump({ step: state.step, status: state.status });

  return {
    makeWorktree(prefix) {
      const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
      tracked.push(dir);
      mkdirSync(flowHomeDir(dir), { recursive: true });
      return dir;
    },
    makeFirstRunWorktree(prefix) {
      const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
      tracked.push(dir);
      return dir;
    },
    nonexistentWorktree(prefix) {
      const base = mkdtempSync(join(tmpdir(), `${prefix}-`));
      tracked.push(base);
      return join(base, 'absent-worktree');
    },
    writeFlowHome(dir, def) {
      const doc = { name: def.name, steps: def.stepIds.map((id) => ({ id, kind: 'manual' })) };
      return write(flowDefFile(dir), yaml.dump(doc));
    },
    writeFlowState(dir, state) {
      return write(flowStateFile(dir), recordText(state));
    },
    writeFlowStateRaw(dir, contents) {
      return write(flowStateFile(dir), contents);
    },
    writeFlowStateOversized(dir, byteLength, base) {
      const text = recordText(base);
      const need = byteLength - Buffer.byteLength(text, 'utf8');
      const padded = need > 0 ? `${text}# ${'x'.repeat(need)}\n` : text;
      return write(flowStateFile(dir), padded);
    },
    plantFlowStateEscape(dir, target) {
      const file = flowStateFile(dir);
      mkdirSync(dirname(file), { recursive: true });
      symlinkSync(target, file);
      return file;
    },
    plantAgentTerminalDirEscape(dir, target) {
      const link = flowHomeDir(dir);
      symlinkSync(target, link);
      return link;
    },
    writeRunRecord(dir, binding) {
      recordDisposition(dir, binding);
      return runDispositionFile(dir);
    },
    writeRunRecordRaw(dir, contents) {
      return write(runDispositionFile(dir), contents);
    },
    plantRunRecordSymlink(dir, target) {
      const file = runDispositionFile(dir);
      mkdirSync(dirname(file), { recursive: true });
      rmSync(file, { recursive: true, force: true });
      symlinkSync(target, file);
      return file;
    },
    plantRunRecordDirectory(dir) {
      return plantNonEmptyDir(runDispositionFile(dir));
    },
    removeRunRecord(dir) {
      rmSync(runDispositionFile(dir), { recursive: true, force: true });
    },
    plantPointerDirectory(dir) {
      return plantNonEmptyDir(activeFlowPointerFile(dir));
    },
    writePointer(dir, raw) {
      return write(activeFlowPointerFile(dir), raw);
    },
    outsideDir(prefix) {
      const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
      tracked.push(dir);
      return dir;
    },
    cleanup() {
      while (tracked.length) rmSync(tracked.pop()!, { recursive: true, force: true });
    },
  };
}
