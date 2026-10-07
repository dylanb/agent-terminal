// §27.9.1 N9b.5(b)/(d), N9b.8 — the run's persisted gate state: `gate-run.yaml`, disjoint from `run-state.yaml`
// so a turn-status persist can neither clobber nor resurrect it.

import path from 'node:path';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { atomicWriteFileSync } from './atomicFile';
import { APP_LOOP_STATE_SCHEMA, loopAreaFile } from './appLoopState';
import { createFlowStateStore } from './flowState';
import { isRecord } from './yamlRecord';
import { isErrno } from './errno';
import { isAutoHaltReason, type AutoHaltReason } from '../shared/gateAuthority';

const GATE_RUN_FILE = 'gate-run.yaml';

export interface RunIdentity {
  flow: string;
  startedAt: number;
}

export interface PersistedLoopRun {
  step: string;
  endedInError: boolean;
  acceptedFailure: boolean;
  needsAHuman: boolean;
  recorded: AutoHaltReason[];
}

export interface PersistedFailedEffect {
  state: 'set' | 'unknown';
  detail: string;
  reported: boolean;
}

/** The gate whose relaunch (j) halt has been written (§27.9.1 N9b.8, AC15). */
export interface RelaunchHalt {
  step: string;
  turnKey: string;
  round: number | null;
}

export interface GateRunState {
  run: RunIdentity;
  loopRun: PersistedLoopRun | null;
  failedEffect: PersistedFailedEffect | null;
  relaunchHalt: RelaunchHalt | null;
}

export type GateRunRead = { kind: 'absent' } | { kind: 'unreadable' } | { kind: 'ok'; state: GateRunState };

/** The identity of the worktree's `in_progress` run, or null when none is in progress. */
export function inProgressRunIdentity(repoDir: string): RunIdentity | null {
  const persisted = createFlowStateStore(repoDir).read();
  if (persisted === null || persisted.status !== 'in_progress') return null;
  if (persisted.flow === undefined || persisted.startedAt === undefined) return null;
  return { flow: persisted.flow, startedAt: persisted.startedAt };
}

export const sameRun = (a: RunIdentity, b: RunIdentity): boolean => a.flow === b.flow && a.startedAt === b.startedAt;

/** Throws when the write cannot land. */
export function writeGateRunState(repoDir: string, state: GateRunState): void {
  const file = loopAreaFile(repoDir, GATE_RUN_FILE);
  if (file === null) throw new Error('§27 loop area is unresolvable');
  const lr = state.loopRun;
  const fe = state.failedEffect;
  const rh = state.relaunchHalt;
  const doc = {
    schema_version: APP_LOOP_STATE_SCHEMA,
    flow: state.run.flow,
    started_at: state.run.startedAt,
    loop_run:
      lr === null
        ? null
        : { step: lr.step, ended_in_error: lr.endedInError, accepted_failure: lr.acceptedFailure, needs_a_human: lr.needsAHuman, recorded: lr.recorded },
    failed_effect: fe === null ? null : { state: fe.state, detail: fe.detail, reported: fe.reported },
    relaunch_halt: rh === null ? null : { step: rh.step, turn_key: rh.turnKey, round: rh.round },
  };
  if (!atomicWriteFileSync(file, yaml.dump(doc))) {
    throw new Error(`cannot write §27 gate state: ${path.dirname(file)} is not a real directory`);
  }
}

export function readGateRunState(repoDir: string): GateRunRead {
  const file = loopAreaFile(repoDir, GATE_RUN_FILE);
  if (file === null) return { kind: 'unreadable' };
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    return isErrno(e, 'ENOENT') ? { kind: 'absent' } : { kind: 'unreadable' };
  }
  let doc: unknown;
  try {
    doc = yaml.load(text);
  } catch {
    return { kind: 'unreadable' };
  }
  const state = decode(doc);
  return state === null ? { kind: 'unreadable' } : { kind: 'ok', state };
}

function decode(doc: unknown): GateRunState | null {
  if (!isRecord(doc) || String(doc.schema_version) !== String(APP_LOOP_STATE_SCHEMA)) return null;
  if (typeof doc.flow !== 'string' || typeof doc.started_at !== 'number' || !Number.isFinite(doc.started_at)) return null;
  const loopRun = doc.loop_run === null ? null : decodeLoopRun(doc.loop_run);
  if (loopRun === undefined) return null;
  const failedEffect = doc.failed_effect === null ? null : decodeFailedEffect(doc.failed_effect);
  if (failedEffect === undefined) return null;
  const relaunchHalt = doc.relaunch_halt === null ? null : decodeRelaunchHalt(doc.relaunch_halt);
  if (relaunchHalt === undefined) return null;
  return { run: { flow: doc.flow, startedAt: doc.started_at }, loopRun, failedEffect, relaunchHalt };
}

function decodeRelaunchHalt(v: unknown): RelaunchHalt | undefined {
  if (!isRecord(v) || typeof v.step !== 'string' || typeof v.turn_key !== 'string') return undefined;
  if (v.round !== null && !(typeof v.round === 'number' && Number.isInteger(v.round) && v.round > 0)) return undefined;
  return { step: v.step, turnKey: v.turn_key, round: v.round };
}

function decodeLoopRun(v: unknown): PersistedLoopRun | undefined {
  if (!isRecord(v) || typeof v.step !== 'string' || v.step.length === 0) return undefined;
  if (typeof v.ended_in_error !== 'boolean' || typeof v.accepted_failure !== 'boolean' || typeof v.needs_a_human !== 'boolean') return undefined;
  if (!Array.isArray(v.recorded) || !v.recorded.every((r): r is AutoHaltReason => typeof r === 'string' && isAutoHaltReason(r))) return undefined;
  return { step: v.step, endedInError: v.ended_in_error, acceptedFailure: v.accepted_failure, needsAHuman: v.needs_a_human, recorded: v.recorded };
}

function decodeFailedEffect(v: unknown): PersistedFailedEffect | undefined {
  if (!isRecord(v) || (v.state !== 'set' && v.state !== 'unknown') || typeof v.detail !== 'string' || typeof v.reported !== 'boolean') return undefined;
  return { state: v.state, detail: v.detail, reported: v.reported };
}
