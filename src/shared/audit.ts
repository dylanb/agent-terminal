// The flow audit record (§25): the on-disk vocabulary, path derivation, serialize↔parse pair, and
// the start-opens/advance-appends classifier — one definition shared by the main-process writer, the
// tests, and a future viewer so the format and its meaning cannot drift (CLAUDE.md src/shared rule).

import yaml from 'js-yaml';
import type { FlowStatus, TodoStatus } from './ipc';

export interface AuditHeader {
  flow: string;
  /** Repo basename (§25.2) — the per-repo directory name. */
  repo: string;
  /** Absolute repo path (the run's true identity under basename collision, §25.7). */
  repoPath: string;
  started: string;
}

export type AuditEvent =
  | { ts: string; type: 'flow.started'; step: string }
  | { ts: string; type: 'flow.status'; from: FlowStatus; to: FlowStatus }
  | { ts: string; type: 'step.entered'; step: string }
  | { ts: string; type: 'flow.completed'; step: string }
  | { ts: string; type: 'todo.created'; id: string; text: string }
  | { ts: string; type: 'todo.status'; id: string; from: TodoStatus; to: TodoStatus }
  | { ts: string; type: 'todo.text'; id: string; text: string }
  | { ts: string; type: 'todo.deleted'; id: string };

/** The minimal flow shape the lifecycle classifier reads (a subset of FlowStateView). */
export interface FlowLike {
  status: FlowStatus;
  stepName: string;
}

/** The minimal todo shape the todo classifier reads (a subset of TodoItem). */
export interface TodoLike {
  id: string;
  text: string;
  status: TodoStatus;
}

export type TransitionKind = 'start' | 'advance' | 'restart' | 'undo';

export function auditTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function auditFileStamp(date: Date): string {
  return auditTimestamp(date).replace(/:/g, '-');
}

/** One complete YAML document, framed as a `---`-delimited block ready to append (§25.3). */
export function serializeDoc(doc: AuditHeader | AuditEvent): string {
  return `---\n${yaml.dump(doc)}`;
}

/** Read a run's append-only stream into its header + ordered events, discarding a trailing partial
 *  document (a crash mid-append) by stopping at the first document that fails to parse (§25.3). */
export function parseAuditStream(text: string): { header: AuditHeader | null; events: AuditEvent[] } {
  const docs: string[] = [];
  let cur: string[] | null = null;
  for (const line of text.split('\n')) {
    if (line === '---') {
      if (cur) docs.push(cur.join('\n'));
      cur = [];
    } else if (cur) {
      cur.push(line);
    }
  }
  if (cur) docs.push(cur.join('\n'));

  let header: AuditHeader | null = null;
  const events: AuditEvent[] = [];
  for (let i = 0; i < docs.length; i++) {
    let parsed: unknown;
    try {
      parsed = yaml.load(docs[i]);
    } catch {
      break; // trailing partial / tail corruption — append-only means it can only be at the end
    }
    if (i === 0) {
      if (parsed && typeof parsed === 'object' && 'flow' in parsed) header = parsed as AuditHeader;
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as { type?: unknown }).type !== 'string') break;
    events.push(parsed as AuditEvent);
  }
  return { header, events };
}

/** The events a flow transition produces, from the before/after view diff (§25.4/§25.5). `start`
 *  opens the run with a single `flow.started`; the append kinds land in Slice 2. */
export function lifecycleEvents(kind: TransitionKind, before: FlowLike, after: FlowLike, ts: string): AuditEvent[] {
  if (kind === 'start') {
    return after.status === 'in_progress' ? [{ ts, type: 'flow.started', step: after.stepName }] : [];
  }
  const events: AuditEvent[] = [];
  if (before.status !== after.status) {
    events.push({ ts, type: 'flow.status', from: before.status, to: after.status });
  }
  if (after.status === 'in_progress' && before.stepName !== after.stepName) {
    events.push({ ts, type: 'step.entered', step: after.stepName });
  }
  if (after.status === 'done') {
    events.push({ ts, type: 'flow.completed', step: after.stepName });
  }
  return events;
}

/** The events a todo-list mutation produces, from the before/after diff (§25.5). A pure reorder
 *  (no id/text/status change) yields nothing. */
export function todoEvents(before: TodoLike[], after: TodoLike[], ts: string): AuditEvent[] {
  const events: AuditEvent[] = [];
  const beforeById = new Map(before.map((t) => [t.id, t]));
  const afterIds = new Set(after.map((t) => t.id));
  for (const t of after) {
    const prev = beforeById.get(t.id);
    if (!prev) {
      events.push({ ts, type: 'todo.created', id: t.id, text: t.text });
      continue;
    }
    if (prev.status !== t.status) events.push({ ts, type: 'todo.status', id: t.id, from: prev.status, to: t.status });
    if (prev.text !== t.text) events.push({ ts, type: 'todo.text', id: t.id, text: t.text });
  }
  for (const t of before) if (!afterIds.has(t.id)) events.push({ ts, type: 'todo.deleted', id: t.id });
  return events;
}
