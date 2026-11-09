// The main-process flow audit writer (§25): opens a run file on flow:start and appends lifecycle
// events on later transitions, never throwing into the flow path (best-effort, §25.1/§25.7). The
// vocabulary, path derivation, serialization, and classifier are shared (src/shared/audit) so the
// on-disk format cannot drift from any reader.

import { appendFileSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { TurnOrigin } from '../shared/turnOrigin';
import { isWindowAnswerFailure } from '../shared/mcpBridge';
import { gateDecisionKind, type McpAuditCall } from '../shared/audit';
import yaml from 'js-yaml';
import {
  auditTimestamp,
  inputEvents,
  lifecycleEvents,
  loopEvents,
  notifyFailedEvent,
  serializeDoc,
  terminateEvents,
  todoEvents,
  type AuditEvent,
  type AuditHeader,
  type AuditOutputFile,
  type FlowLike,
  type LoopLike,
  type TodoLike,
  type TransitionKind,
} from '../shared/audit';
import { auditFilePath } from './auditPaths';
import { pathWithin } from './artifactTree';
import { isRecord } from './yamlRecord';
import { confinedRealPath, resolveOwnedDirJail } from './confinedPath';

const POINTER_REL = path.join('.agent-terminal', 'audit-pointer.yaml');

// Top-level `.agent-loop/` regular files as `{ path, bytes }` (§25.5), realpath-guarded against the
// repo root so a symlink — whether a file inside `.agent-loop/` or `.agent-loop/` itself — cannot
// escape the repo (§20.2/§25.7; anchored on the repo root like `readArtifact`, not on `.agent-loop`).
// Sorted for a stable snapshot; throws on a missing dir (the caller's try/catch drops the snapshot —
// best-effort, §25.1).
function agentLoopFiles(repoKey: string): AuditOutputFile[] {
  const dir = path.join(repoKey, '.agent-loop');
  const realRoot = realpathSync(repoKey);
  const files: AuditOutputFile[] = [];
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    try {
      const real = realpathSync(abs);
      if (!pathWithin(realRoot, real)) continue;
      const st = statSync(real);
      if (st.isFile()) files.push({ path: `.agent-loop/${name}`, bytes: st.size });
    } catch {
      /* unreadable entry — skip it, keep the rest of the snapshot */
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export interface AuditRecorderDeps {
  /** Audit root (§25.2) — `~/.agent-terminal/audit` in production, a temp dir under test. */
  root: string;
  now: () => Date;
  flowName: (repoKey: string) => string | null;
  log?: (msg: string, err: unknown) => void;
}

export interface AuditRunStart {
  startedAt: number;
  flow: string;
}

type AuditPrompt = Extract<AuditEvent, { type: 'mcp.prompt' }>;

interface McpRecording {
  repo: string;
  call: McpAuditCall;
  prompt: AuditPrompt | null;
  active: boolean;
  events: { file: string; event: AuditEvent }[];
  file: string | null;
}

export interface AuditRecorder {
  beginPrompt(repo: string, prompt: AuditPrompt): void;
  forgetPrompt(prompt: AuditPrompt): void;
  recordPrompt(prompt: AuditPrompt): void;
  recordPrompts(discovery: Promise<AuditPrompt[]>): Promise<void>;
  recordMcpCall(repo: string, tool: string, origin: TurnOrigin, prompt: AuditPrompt | null, act: () => Promise<unknown>): Promise<unknown>;
  observeMcpOrigin(origin: TurnOrigin, prompt: AuditPrompt | null): void;
  deliveryObserver(): (reason?: string) => void;

  recordTransition(repoKey: string, kind: TransitionKind, before: FlowLike, after: FlowLike, start?: AuditRunStart): void;
  /** Record a todo-list mutation, but only while a run is open for the repo (§25.4). */
  recordTodoChange(repoKey: string, before: TodoLike[], after: TodoLike[]): void;
  /** Record a loop-state observation for the run, diffing against the last seen (§25.5). Fed by the
   *  surviving §27 loop-view provider — the app no longer writes or interprets .agent-loop/, but still
   *  snapshots its bytes for the §25 record. */
  recordLoop(repoKey: string, loop: LoopLike | null): void;
  /** Record resolved step inputs and any ticket association (§25.5), only while a run is open. */
  recordInputs(repoKey: string, values: Record<string, string>, typeByName: Record<string, string>): void;
  /** Record a flow-injected command and its exit (§25.5), only while a run is open. */
  recordCommand(repoKey: string, source: string, cmd: string, exit: number | null): void;
  /** Record the OS refusing to deliver a §24.2.3 T4 attention notification, only while a run is open.
   *  `reason` is the OS's untrusted message; the record bounds and strips it. */
  recordNotifyFailed(repoKey: string, reason: string): void;
  /** Record a flow Terminate (#26): append a `flow.terminated` event to the open run, then finalize
   *  it so the next start opens a new run. Best-effort — never throws into the flow path. */
  recordTerminate(repoKey: string): void;
}

export function createAuditRecorder(deps: AuditRecorderDeps): AuditRecorder {
  const { root, now, flowName } = deps;
  const log = deps.log ?? ((m, e): void => console.error(m, e));
  const open = new Map<string, string>();
  const calls = new AsyncLocalStorage<McpRecording>();
  const recordedPrompts = new Map<string, Set<string>>();
  const promptRuns = new Map<string, { repo: string; file: string | null }>();
  const pendingCalls = new Map<string, Set<object>>();
  const endings = new Map<string, AuditEvent[]>();
  const closed = new Set<string>();
  const confinedFile = (file: string): string => {
    const jail = resolveOwnedDirJail(root);
    const resolved = jail === null || !path.isAbsolute(file) ? null : confinedRealPath(jail, file);
    if (resolved === null) throw new Error('Audit destination is outside its owned root or cannot be resolved.');
    return resolved;
  };
  const writeEvents = (file: string, events: AuditEvent[]): void => {
    const recorded = recordedPrompts.get(file) ?? new Set<string>();
    const pending = events.filter(event => event.type !== 'mcp.prompt' || !recorded.has(event.id));
    if (pending.length === 0) return;
    appendFileSync(confinedFile(file), pending.map(serializeDoc).join(''));
    for (const event of pending) if (event.type === 'mcp.prompt') recorded.add(event.id);
    if (recorded.size) recordedPrompts.set(file, recorded);
  };
  const release = (call: McpRecording): void => {
    if (!call.file) return;
    const pending = pendingCalls.get(call.file);
    pending?.delete(call);
    if (pending?.size === 0) pendingCalls.delete(call.file);
    safe(() => finishRun(call.file!));
  };
  const attach = (call: McpRecording, file: string): void => {
    if (call.file && call.file !== file) {
      for (const item of call.events) safe(() => writeEvents(item.file, [item.event]));
      call.events = [];
      release(call);
    }
    call.file = file;
    const pending = pendingCalls.get(file) ?? new Set<object>();
    pending.add(call);
    pendingCalls.set(file, pending);
  };
  const finishRun = (file: string): void => {
    const ending = endings.get(file);
    if (!ending || pendingCalls.get(file)?.size) return;
    endings.delete(file);
    recordedPrompts.delete(file);
    writeEvents(file, ending);
  };
  const safe = (act: () => void): void => {
    try { act(); } catch (error) { log('audit MCP recording failed', error); }
  };
  const append = (repo: string, file: string, events: AuditEvent[]): void => {
    const call = calls.getStore();
    if (call?.active && call.repo === repo) {
      if (call.file === null) attach(call, file);
      call.events.push(...events.map(event => ({ file: call.file!, event })));
    } else writeEvents(file, events);
  };
  const recordPromptAt = (repo: string, file: string, prompt: AuditPrompt): void => safe(() => {
    const recorded = recordedPrompts.get(file) ?? new Set<string>();
    if (recorded.has(prompt.id)) return;
    append(repo, file, [prompt]);
  });
  const recordPrompt = (prompt: AuditPrompt): void => {
    const binding = promptRuns.get(prompt.id);
    if (binding?.file && currentFile(binding.repo) === binding.file) recordPromptAt(binding.repo, binding.file, prompt);
  };

  // Last agent-loop state seen within the current run, for the per-observation diff (§25.5). Reset on
  // a fresh start so a re-run re-records the initial loop status rather than diffing against the prior run.
  const lastLoop = new Map<string, LoopLike>();

  // Append complete event documents to a run file iff one is open for the repo (§25.4); no-op otherwise.
  const appendIfOpen = (repoKey: string, events: AuditEvent[]): void => {
    if (events.length === 0) return;
    const context = calls.getStore();
    const file = context?.active && context.repo === repoKey ? context.file : currentFile(repoKey);
    if (!file) return;
    append(repoKey, file, events);
  };

  const pointerPath = (repoKey: string): string => path.join(repoKey, POINTER_REL);

  const writePointer = (repoKey: string, file: string): void => {
    const pp = pointerPath(repoKey);
    mkdirSync(path.dirname(pp), { recursive: true });
    writeFileSync(pp, yaml.dump({ file }));
  };

  // The repo's open run file: the in-memory slot, else the persisted pointer (survives an app restart
  // mid-run, §25.4). Null when no run has been opened → callers record nothing.
  const currentFile = (repoKey: string): string | null => {
    const live = open.get(repoKey);
    if (live) return live;
    if (closed.has(repoKey)) return null;
    try {
      const p = yaml.load(readFileSync(pointerPath(repoKey), 'utf8'));
      if (isRecord(p) && typeof p.file === 'string' && p.file.length > 0) {
        const file = confinedFile(p.file);
        open.set(repoKey, file);
        return file;
      }
    } catch {
      /* no pointer yet → no open run */
    }
    return null;
  };

  return {
    beginPrompt(repo, prompt) {
      if (!promptRuns.has(prompt.id)) promptRuns.set(prompt.id, { repo, file: currentFile(repo) });
    },
    forgetPrompt(prompt) { promptRuns.delete(prompt.id); },
    recordPrompt,
    async recordPrompts(discovery) {
      const bindings = new Map([...promptRuns].filter(([, binding]) => binding.file && currentFile(binding.repo) === binding.file));
      const files = new Set([...bindings.values()].map(binding => binding.file!));
      const observation = {};
      for (const file of files) {
        const pending = pendingCalls.get(file) ?? new Set<object>();
        pending.add(observation);
        pendingCalls.set(file, pending);
      }
      try {
        for (const prompt of await discovery) {
          const binding = bindings.get(prompt.id);
          if (binding?.file) safe(() => writeEvents(binding.file!, [prompt]));
        }
      } catch (error) { log('audit prompt discovery failed', error); }
      finally {
        for (const file of files) {
          const pending = pendingCalls.get(file);
          pending?.delete(observation);
          if (pending?.size === 0) pendingCalls.delete(file);
          safe(() => finishRun(file));
        }
      }
    },
    observeMcpOrigin(origin, prompt) {
      const context = calls.getStore();
      if (!context?.active) return;
      context.call.origin = origin;
      context.prompt = origin === 'human' ? prompt : null;
      delete context.call.promptId;
      if (context.prompt) {
        context.call.promptId = context.prompt.id;
        if (context.file) recordPromptAt(context.repo, context.file, context.prompt);
      }
    },
    deliveryObserver() {
      const context = calls.getStore();
      const file = context?.file;
      return reason => safe(() => {
        if (!context || !file || currentFile(context.repo) !== file) return;
        writeEvents(file, [{ type: 'mcp.delivery', ts: auditTimestamp(now()), sendId: context.call.callId,
          outcome: reason === undefined ? 'submitted' : 'dropped', ...(reason === undefined ? {} : { reason }) }]);
      });
    },
    async recordMcpCall(repo, tool, origin, prompt, act) {
      const context: McpRecording = { repo, prompt: origin === 'human' ? prompt : null, active: true,
        file: currentFile(repo), events: [], call: { callId: randomUUID(), tool, origin, outcome: 'result-unknown',
          ...(origin === 'human' && prompt ? { promptId: prompt.id } : {}) } };
      if (context.file) {
        attach(context, context.file);
        if (context.prompt) recordPromptAt(repo, context.file, context.prompt);
      }
      return calls.run(context, async () => {
        let result: unknown;
        try {
          result = await act();
          context.call.outcome = isRecord(result) && typeof result.kind === 'string' ? result.kind : 'success';
          if (isWindowAnswerFailure(result)) context.call.reason = result.message;
          return result;
        } finally {
          context.active = false;
          safe(() => {
            const unguarded = tool === 'read_state' || (tool.startsWith('todo_') && tool !== 'todo_send') || tool === 'capture_report';
            const record = context.call.origin === 'human' || !unguarded || (tool !== 'read_state' && !isWindowAnswerFailure(result));
            const candidates = context.events.filter(({ event }) =>
              (tool.startsWith('todo_') && event.type.startsWith('todo.'))
              || (tool === 'start' && event.type === 'flow.started')
              || (['approve', 'request_changes', 'redo', 'polish'].includes(tool)
                && ((event.type === 'command' && gateDecisionKind(event.cmd)?.kind === 'decision')
                  || (tool === 'approve' && event.type === 'step.entered'))));
            const chosen = candidates.find(({ event }) => event.type === 'command') ?? candidates[0];
            if (record && context.file) {
              if (chosen) chosen.event = { ...chosen.event, mcp: context.call };
              else {
                const event: AuditEvent = { type: 'mcp.call', ts: auditTimestamp(now()), mcp: context.call };
                const end = context.events.findIndex(item => item.event.type === 'flow.terminated');
                context.events.splice(end < 0 ? context.events.length : end, 0, { file: context.file, event });
              }
            }
            for (const { file, event } of context.events) safe(() => writeEvents(file, [event]));
          });
          release(context);
        }
      });
    },
    recordTransition(repoKey, kind, before, after, start) {
      try {
        const date = kind === 'start' && start !== undefined ? new Date(start.startedAt) : now();
        const ts = auditTimestamp(date);
        if (kind === 'start') {
          if (after.status !== 'in_progress') return;
          const flow = start !== undefined ? start.flow : flowName(repoKey);
          if (!flow) return;
          const file = confinedFile(auditFilePath(root, repoKey, flow, date));
          const header: AuditHeader = { flow, repo: path.basename(repoKey), repoPath: repoKey, started: ts };
          const events = lifecycleEvents('start', before, after, ts);
          // The record carries the repo path, resolved input values, and injected commands — owner-only
          // so a shared host cannot read another user's flow (CWE-276).
          mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
          writeFileSync(file, serializeDoc(header), { mode: 0o600 });
          open.set(repoKey, file);
          closed.delete(repoKey);
          const call = calls.getStore();
          if (call?.active && call.repo === repoKey && call.call.tool === 'start') attach(call, file);
          if (call?.active && call.repo === repoKey && call.prompt) {
            promptRuns.set(call.prompt.id, { repo: repoKey, file });
            recordPrompt(call.prompt);
          }
          append(repoKey, file, events);
          lastLoop.delete(repoKey);
          writePointer(repoKey, file);
          return;
        }
        const file = currentFile(repoKey);
        if (!file) return;
        const events = lifecycleEvents(kind, before, after, ts);
        if (events.length > 0) append(repoKey, file, events);
      } catch (e) {
        log('audit recordTransition failed', e);
      }
    },

    recordTodoChange(repoKey, before, after) {
      try {
        appendIfOpen(repoKey, todoEvents(before, after, auditTimestamp(now())));
      } catch (e) {
        log('audit recordTodoChange failed', e);
      }
    },

    recordLoop(repoKey, loop) {
      try {
        if (!loop || !currentFile(repoKey)) return;
        const ts = auditTimestamp(now());
        const events = loopEvents(lastLoop.get(repoKey) ?? null, loop, ts);
        if (events.length === 0) return;
        appendIfOpen(repoKey, events);
        lastLoop.set(repoKey, { status: loop.status, iteration: loop.iteration, pr: loop.pr });
        // §25.5: snapshot the loop's outputs at each status change (a gate is a status change).
        if (events.some((e) => e.type === 'loop.status')) {
          let files: AuditOutputFile[] = [];
          try {
            files = agentLoopFiles(repoKey);
          } catch {
            /* no .agent-loop dir yet → empty snapshot */
          }
          appendIfOpen(repoKey, [{ ts, type: 'outputs.snapshot', pr: loop.pr, files }]);
        }
      } catch (e) {
        log('audit recordLoop failed', e);
      }
    },

    recordInputs(repoKey, values, typeByName) {
      try {
        appendIfOpen(repoKey, inputEvents(values, typeByName, auditTimestamp(now())));
      } catch (e) {
        log('audit recordInputs failed', e);
      }
    },

    recordCommand(repoKey, source, cmd, exit) {
      try {
        appendIfOpen(repoKey, [{ ts: auditTimestamp(now()), type: 'command', source, cmd, exit }]);
      } catch (e) {
        log('audit recordCommand failed', e);
      }
    },

    recordNotifyFailed(repoKey, reason) {
      try {
        appendIfOpen(repoKey, [notifyFailedEvent(reason, auditTimestamp(now()))]);
      } catch (e) {
        log('audit recordNotifyFailed failed', e);
      }
    },

    recordTerminate(repoKey) {
      try {
        const file = currentFile(repoKey);
        if (file) endings.set(file, terminateEvents(auditTimestamp(now())));
        closed.add(repoKey);
        open.delete(repoKey);
        lastLoop.delete(repoKey);
        if (file) safe(() => finishRun(file));
        rmSync(pointerPath(repoKey), { force: true }); // §25.4 restart-surviving run pointer
      } catch (e) {
        log('audit recordTerminate failed', e);
      }
    },
  };
}
