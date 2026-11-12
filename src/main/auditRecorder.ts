// The main-process flow audit writer (§25): opens a run file on flow:start and appends lifecycle
// events on later transitions, never throwing into the flow path (best-effort, §25.1/§25.7). The
// vocabulary, path derivation, serialization, and classifier are shared (src/shared/audit) so the
// on-disk format cannot drift from any reader.

import { appendFileSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  auditEventTimestamp,
  auditTimestamp,
  inputEvents,
  lifecycleEvents,
  loopEvents,
  notifyFailedEvent,
  parseAuditStream,
  reconstructTimeline,
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
import type { AgentKind } from '../shared/agentKind';
import { isStepTokens, type StepTokens } from '../shared/tokenCounts';
import { confinedRealPath, resolveOwnedDirJail } from './confinedPath';
import { auditFilePath, auditFileStartedAt, auditRepoDir } from './auditPaths';
import type { AuditRunId } from './auditRun';
import { pathWithin } from './artifactTree';
import { isRecord } from './yamlRecord';

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
  /** `step`'s counts in `run` as of `closedAt`, the instant one of its windows closed. */
  countsAtClose?: (run: AuditRunId, step: string, closedAt: Date) => Promise<StepTokens>;
  log?: (msg: string, err: unknown) => void;
}

export interface AuditRunStart {
  startedAt: number;
  flow: string;
}

export interface AuditRecorder {
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
  /** Record the value a deciding step's approve recorded (§25.5), only while a run is open. */
  recordDecision(repoKey: string, step: string, value: string): void;
  /** Record a flow Terminate (#26): append a `flow.terminated` event to the open run, then finalize
   *  it so the next start opens a new run. Best-effort — never throws into the flow path. */
  recordTerminate(repoKey: string): void;
  /** Record that the terminal hosted `agent` during the run, only while a run is open. */
  recordHostedAgent(repoKey: string, agent: AgentKind): void;
  /** Resolves once every step count asked for so far is in its run's record or was dropped. */
  settled(): Promise<void>;
}

const POINTER_LOG_MAX = 200;

/** One repo reached by 2 spellings of its path, such as through a link, is the same repo. */
function sameDir(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

export function createAuditRecorder(deps: AuditRecorderDeps): AuditRecorder {
  const { root, now, flowName } = deps;
  const log = deps.log ?? ((m, e): void => console.error(m, e));
  const open = new Map<string, string>();
  const runs = new Map<string, AuditRunId>();
  // A refused pointer's text, so the same pointer is neither re-read nor logged again.
  const refused = new Map<string, string>();
  const pending = new Set<Promise<void>>();
  // Last agent-loop state seen within the current run, for the per-observation diff (§25.5). Reset on
  // a fresh start so a re-run re-records the initial loop status rather than diffing against the prior run.
  const lastLoop = new Map<string, LoopLike>();

  // Append complete event documents to a run file iff one is open for the repo (§25.4); no-op otherwise.
  const appendIfOpen = (repoKey: string, events: AuditEvent[]): void => {
    if (events.length === 0) return;
    const file = currentFile(repoKey);
    if (!file) return;
    appendFileSync(file, events.map(serializeDoc).join(''));
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
    try {
      const text = readFileSync(pointerPath(repoKey), 'utf8');
      if (refused.get(repoKey) === text) return null;
      const p = yaml.load(text);
      if (isRecord(p) && typeof p.file === 'string' && p.file.length > 0) {
        const jail = resolveOwnedDirJail(auditRepoDir(root, repoKey));
        const file = jail && confinedRealPath(jail, p.file);
        const run = file ? recoveredRun(file) : null;
        if (!file || run === null || !sameDir(run.repoPath, repoKey)) {
          refused.set(repoKey, text);
          log('audit pointer refused: it names no run record of this repo', JSON.stringify(p.file.slice(0, POINTER_LOG_MAX)));
          return null;
        }
        open.set(repoKey, file);
        runs.set(repoKey, run);
        return file;
      }
    } catch {
      /* no pointer yet → no open run */
    }
    return null;
  };

  const recoveredRun = (file: string): AuditRunId | null => {
    try {
      const { header } = parseAuditStream(readFileSync(file, 'utf8'));
      const started = auditFileStartedAt(path.basename(file));
      if (!header || typeof header.flow !== 'string' || typeof header.repoPath !== 'string' || !started) return null;
      return { repoPath: header.repoPath, flow: header.flow, started };
    } catch {
      return null;
    }
  };

  // Each file's last queued count write: a close's counts are appended only after the earlier closes' (§25.4),
  // however their reads interleave.
  const lastWrite = new Map<string, Promise<void>>();

  const recordCounts = (file: string, run: AuditRunId | undefined, step: string, closedAt: Date): void => {
    const { countsAtClose } = deps;
    if (!countsAtClose) return;
    if (!run) {
      log('audit step counts dropped: the run record names no run', file);
      return;
    }
    const counts = Promise.resolve().then(() => countsAtClose(run, step, closedAt));
    const entry = (lastWrite.get(file) ?? Promise.resolve())
      .then(() => counts)
      .then((c) => {
        const valid = isStepTokens(c);
        if (!valid) log('audit step counts are not valid step counts; recorded unavailable', JSON.stringify(step));
        appendFileSync(file, serializeDoc({ ts: auditEventTimestamp(closedAt), type: 'step.tokens', step, counts: valid ? c : { state: 'unavailable' } }));
      })
      .catch((e: unknown) => log('audit step counts failed', e))
      .finally(() => {
        pending.delete(entry);
        if (lastWrite.get(file) === entry) lastWrite.delete(file);
      });
    lastWrite.set(file, entry);
    pending.add(entry);
  };

  const openStep = (file: string): string | null => {
    try {
      const last = reconstructTimeline(readFileSync(file, 'utf8')).visits.at(-1);
      return last !== undefined && last.exited === null ? last.step : null;
    } catch (e) {
      log('audit open step unreadable', e);
      return null;
    }
  };

  return {
    recordTransition(repoKey, kind, before, after, start) {
      try {
        const date = kind === 'start' && start !== undefined ? new Date(start.startedAt) : now();
        const ts = auditEventTimestamp(date);
        if (kind === 'start') {
          if (after.status !== 'in_progress') return;
          const flow = start !== undefined ? start.flow : flowName(repoKey);
          if (!flow) return;
          const file = auditFilePath(root, repoKey, flow, date);
          const header: AuditHeader = { flow, repo: path.basename(repoKey), repoPath: repoKey, started: auditTimestamp(date) };
          const events = lifecycleEvents('start', before, after, ts);
          // The record carries the repo path, resolved input values, and injected commands — owner-only
          // so a shared host cannot read another user's flow (CWE-276).
          mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
          writeFileSync(file, serializeDoc(header) + events.map(serializeDoc).join(''), { mode: 0o600 });
          open.set(repoKey, file);
          runs.set(repoKey, { repoPath: repoKey, flow, started: date });
          lastLoop.delete(repoKey);
          writePointer(repoKey, file);
          return;
        }
        const file = currentFile(repoKey);
        if (!file) return;
        const events = lifecycleEvents(kind, before, after, ts);
        if (events.length === 0) return;
        appendFileSync(file, events.map(serializeDoc).join(''));
        const closes = before.status === 'in_progress' && (after.status !== 'in_progress' || after.stepName !== before.stepName);
        if (closes) recordCounts(file, runs.get(repoKey), before.stepName, date);
      } catch (e) {
        log('audit recordTransition failed', e);
      }
    },

    recordTodoChange(repoKey, before, after) {
      try {
        appendIfOpen(repoKey, todoEvents(before, after, auditEventTimestamp(now())));
      } catch (e) {
        log('audit recordTodoChange failed', e);
      }
    },

    recordLoop(repoKey, loop) {
      try {
        if (!loop || !currentFile(repoKey)) return;
        const ts = auditEventTimestamp(now());
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
        appendIfOpen(repoKey, inputEvents(values, typeByName, auditEventTimestamp(now())));
      } catch (e) {
        log('audit recordInputs failed', e);
      }
    },

    recordCommand(repoKey, source, cmd, exit) {
      try {
        appendIfOpen(repoKey, [{ ts: auditEventTimestamp(now()), type: 'command', source, cmd, exit }]);
      } catch (e) {
        log('audit recordCommand failed', e);
      }
    },

    recordNotifyFailed(repoKey, reason) {
      try {
        appendIfOpen(repoKey, [notifyFailedEvent(reason, auditEventTimestamp(now()))]);
      } catch (e) {
        log('audit recordNotifyFailed failed', e);
      }
    },

    recordDecision(repoKey, step, value) {
      try {
        appendIfOpen(repoKey, [{ ts: auditTimestamp(now()), type: 'decision', step, value }]);
      } catch (e) {
        log('audit recordDecision failed', e);
      }
    },

    recordTerminate(repoKey) {
      try {
        const file = currentFile(repoKey);
        if (file) {
          const run = runs.get(repoKey);
          const step = openStep(file);
          const date = now();
          appendFileSync(file, terminateEvents(auditEventTimestamp(date)).map(serializeDoc).join(''));
          if (step !== null) recordCounts(file, run, step, date);
        }
        open.delete(repoKey);
        runs.delete(repoKey);
        lastLoop.delete(repoKey);
        rmSync(pointerPath(repoKey), { force: true }); // §25.4 restart-surviving run pointer
      } catch (e) {
        log('audit recordTerminate failed', e);
      }
    },

    recordHostedAgent(repoKey, agent) {
      try {
        appendIfOpen(repoKey, [{ ts: auditEventTimestamp(now()), type: 'agent.hosted', agent }]);
      } catch (e) {
        log('audit recordHostedAgent failed', e);
      }
    },

    async settled() {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
  };
}
