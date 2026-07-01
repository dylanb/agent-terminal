// The flow audit record (§25): the on-disk vocabulary, path derivation, serialize↔parse pair, and
// the start-opens/advance-appends classifier — one definition shared by the main-process writer, the
// tests, and a future viewer so the format and its meaning cannot drift (CLAUDE.md src/shared rule).

import yaml from 'js-yaml';
import type { FlowStatus, TodoStatus } from './ipc';
import { stripStatusControlChars } from './loopStatus';

export interface AuditHeader {
  flow: string;
  /** Repo basename (§25.2) — the per-repo directory name. */
  repo: string;
  /** Absolute repo path (the run's true identity under basename collision, §25.7). */
  repoPath: string;
  started: string;
}

/** The flow statuses the §25.5 `flow.status` event records — the lifecycle trio, never the `error`
 *  view (which is a benign malformed-request view, not a recorded run state). */
export type AuditFlowStatus = Exclude<FlowStatus, 'error'>;

export type AuditEvent =
  | { ts: string; type: 'flow.started'; step: string }
  | { ts: string; type: 'flow.status'; from: AuditFlowStatus; to: AuditFlowStatus }
  | { ts: string; type: 'step.entered'; step: string }
  | { ts: string; type: 'flow.completed'; step: string }
  | { ts: string; type: 'flow.terminated' }
  | { ts: string; type: 'todo.created'; id: string; text: string }
  | { ts: string; type: 'todo.status'; id: string; from: TodoStatus; to: TodoStatus }
  | { ts: string; type: 'todo.text'; id: string; text: string }
  | { ts: string; type: 'todo.deleted'; id: string }
  // Phase 2 — loop integration (§25.5).
  | { ts: string; type: 'input.resolved'; name: string; value: string }
  | { ts: string; type: 'ticket.assoc'; ticket: number }
  | { ts: string; type: 'pr.assoc'; pr: number }
  | { ts: string; type: 'loop.status'; from: string; to: string }
  | { ts: string; type: 'loop.iteration'; n: number }
  | { ts: string; type: 'command'; source: string; cmd: string; exit: number | null }
  | { ts: string; type: 'outputs.snapshot'; pr: number | null; files: AuditOutputFile[] }
  // §26.10 — the per-iteration cost meter: the priced dollars + any unpriced model ids, tagged by iteration.
  | { ts: string; type: 'loop.cost'; iteration: number; usd: number; unpriced: string[] };

/** One file captured in an `outputs.snapshot` (§25.5): a `.agent-loop/`-relative path and its size. */
export interface AuditOutputFile {
  path: string;
  bytes: number;
}

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

/** The minimal agent-loop shape the loop classifier diffs (a subset of FlowLoopView, §24.2.3 T2). */
export interface LoopLike {
  status: string;
  iteration: number;
  pr: number | null;
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
  if (before.status !== after.status && before.status !== 'error' && after.status !== 'error') {
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

/** The single event a flow Terminate produces (#26 / §25): a timestamped `flow.terminated`, distinct
 *  from the lifecycle transitions, from which the reconstructed timeline reads not_started again. */
export function terminateEvents(ts: string): AuditEvent[] {
  return [{ ts, type: 'flow.terminated' }];
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

/** The events an agent-loop state.yaml observation produces, from the before/after diff (§25.5).
 *  First observation (`before` null) records the initial status + iteration (and PR if present); a
 *  later observation records only what changed. An absent `after` (left the loop step) yields nothing. */
export function loopEvents(before: LoopLike | null, after: LoopLike | null, ts: string): AuditEvent[] {
  if (!after) return [];
  const events: AuditEvent[] = [];
  if (!before || before.status !== after.status) {
    events.push({
      ts,
      type: 'loop.status',
      from: before ? stripStatusControlChars(before.status) : '',
      to: stripStatusControlChars(after.status),
    });
  }
  if (!before || before.iteration !== after.iteration) {
    events.push({ ts, type: 'loop.iteration', n: after.iteration });
  }
  if (after.pr !== null && (!before || before.pr !== after.pr)) {
    events.push({ ts, type: 'pr.assoc', pr: after.pr });
  }
  return events;
}

/** A run replayed from its append-only stream (§25.6): the ordered events plus the folded final
 *  state they reconstruct — proof that a complete timeline is recoverable from the record alone. */
export interface RunTimeline {
  header: AuditHeader | null;
  events: AuditEvent[];
  flow: { status: FlowStatus; step: string };
  ticket: number | null;
  pr: number | null;
  loop: { status: string; iteration: number } | null;
  inputs: Record<string, string>;
  todos: TodoLike[];
  commands: { source: string; cmd: string; exit: number | null }[];
  snapshots: { pr: number | null; files: AuditOutputFile[] }[];
  /** The §26.10 per-iteration cost events, in order — priced dollars + any unpriced model ids per iteration. */
  costs: { iteration: number; usd: number; unpriced: string[] }[];
}

/** Replay a run's stream into its ordered timeline and folded final state (§25.6), tolerating a
 *  trailing partial document (parseAuditStream stops at the first unparseable doc). */
export function reconstructTimeline(text: string): RunTimeline {
  const { header, events } = parseAuditStream(text);
  const tl: RunTimeline = {
    header,
    events,
    flow: { status: 'not_started', step: '' },
    ticket: null,
    pr: null,
    loop: null,
    inputs: {},
    todos: [],
    commands: [],
    snapshots: [],
    costs: [],
  };
  const todoOf = (id: string): TodoLike | undefined => tl.todos.find((t) => t.id === id);
  for (const e of events) {
    switch (e.type) {
      case 'flow.started':
        tl.flow = { status: 'in_progress', step: e.step };
        break;
      case 'flow.status':
        tl.flow.status = e.to;
        break;
      case 'step.entered':
      case 'flow.completed':
        tl.flow.step = e.step;
        break;
      case 'flow.terminated':
        tl.flow = { status: 'not_started', step: '' };
        break;
      case 'todo.created':
        tl.todos.push({ id: e.id, text: e.text, status: 'active' });
        break;
      case 'todo.status': {
        const t = todoOf(e.id);
        if (t) t.status = e.to;
        break;
      }
      case 'todo.text': {
        const t = todoOf(e.id);
        if (t) t.text = e.text;
        break;
      }
      case 'todo.deleted':
        tl.todos = tl.todos.filter((t) => t.id !== e.id);
        break;
      case 'input.resolved':
        tl.inputs[e.name] = e.value;
        break;
      case 'ticket.assoc':
        tl.ticket = e.ticket;
        break;
      case 'pr.assoc':
        tl.pr = e.pr;
        break;
      case 'loop.status':
        tl.loop = { status: e.to, iteration: tl.loop?.iteration ?? 0 };
        break;
      case 'loop.iteration':
        tl.loop = { status: tl.loop?.status ?? '', iteration: e.n };
        break;
      case 'command':
        tl.commands.push({ source: e.source, cmd: e.cmd, exit: e.exit });
        break;
      case 'outputs.snapshot':
        tl.snapshots.push({ pr: e.pr, files: e.files });
        break;
      case 'loop.cost':
        tl.costs.push({ iteration: e.iteration, usd: e.usd, unpriced: e.unpriced });
        break;
    }
  }
  return tl;
}

/** The events resolving a step's typed inputs produces (§25.5): an `input.resolved` per value, plus a
 *  `ticket.assoc` when a `github-ticket` input (per `typeByName`) resolved to a positive integer —
 *  explicit ID sourcing only, never scraped (§25.7). */
export function inputEvents(
  values: Record<string, string>,
  typeByName: Record<string, string>,
  ts: string,
): AuditEvent[] {
  const events: AuditEvent[] = [];
  for (const name of Object.keys(values)) {
    const value = values[name];
    events.push({ ts, type: 'input.resolved', name, value });
    if (typeByName[name] === 'github-ticket') {
      const ticket = Number(value);
      if (Number.isInteger(ticket) && ticket > 0) events.push({ ts, type: 'ticket.assoc', ticket });
    }
  }
  return events;
}
