// The main-process flow audit writer (§25): opens a run file on flow:start and appends lifecycle
// events on later transitions, never throwing into the flow path (best-effort, §25.1/§25.7). The
// vocabulary, path derivation, serialization, and classifier are shared (src/shared/audit) so the
// on-disk format cannot drift from any reader.

import { appendFileSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  appCostEvent,
  loopCostEvent,
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
import type { CostResult } from '../shared/pricing';
import type { CiSnapshot } from './ciChecks';
import { auditFilePath } from './auditPaths';
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
  log?: (msg: string, err: unknown) => void;
}

export interface AuditRecorder {
  recordTransition(repoKey: string, kind: TransitionKind, before: FlowLike, after: FlowLike): void;
  /** Record a todo-list mutation, but only while a run is open for the repo (§25.4). */
  recordTodoChange(repoKey: string, before: TodoLike[], after: TodoLike[]): void;
  /** Record an agent-loop state.yaml observation, diffing against the last seen for the run (§25.5). */
  recordLoop(repoKey: string, loop: LoopLike | null): void;
  /** Record resolved step inputs and any ticket association (§25.5), only while a run is open. */
  recordInputs(repoKey: string, values: Record<string, string>, typeByName: Record<string, string>): void;
  /** Record a flow-injected command and its exit (§25.5), only while a run is open. */
  recordCommand(repoKey: string, source: string, cmd: string, exit: number | null): void;
  /** Record the §26.10 per-iteration cost (priced dollars + unpriced model ids), only while a run is open. */
  recordCost(repoKey: string, iteration: number, cost: CostResult): void;
  /** Record the §27.11 whole-run cost (priced dollars + unpriced model ids), only while a run is open.
   *  Returns whether the append landed, so the §27 meter can re-attempt the same figure on its next
   *  sample; a repo with no open run has nothing to append and reports true. */
  recordAppCost(repoKey: string, cost: CostResult): boolean;
  /** Record the §26.7 per-iteration CI snapshot (run-don't-block), only while a run is open. Best-effort. */
  recordCi(repoKey: string, iteration: number, snapshot: CiSnapshot): void;
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
      const p = yaml.load(readFileSync(pointerPath(repoKey), 'utf8'));
      if (isRecord(p) && typeof p.file === 'string' && p.file.length > 0) {
        open.set(repoKey, p.file);
        return p.file;
      }
    } catch {
      /* no pointer yet → no open run */
    }
    return null;
  };

  return {
    recordTransition(repoKey, kind, before, after) {
      try {
        const date = now();
        const ts = auditTimestamp(date);
        if (kind === 'start') {
          if (after.status !== 'in_progress') return;
          const flow = flowName(repoKey);
          if (!flow) return;
          const file = auditFilePath(root, repoKey, flow, date);
          const header: AuditHeader = { flow, repo: path.basename(repoKey), repoPath: repoKey, started: ts };
          const events = lifecycleEvents('start', before, after, ts);
          // The record carries the repo path, resolved input values, and injected commands — owner-only
          // so a shared host cannot read another user's flow (CWE-276).
          mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
          writeFileSync(file, serializeDoc(header) + events.map(serializeDoc).join(''), { mode: 0o600 });
          open.set(repoKey, file);
          lastLoop.delete(repoKey);
          writePointer(repoKey, file);
          return;
        }
        const file = currentFile(repoKey);
        if (!file) return;
        const events = lifecycleEvents(kind, before, after, ts);
        if (events.length > 0) appendFileSync(file, events.map(serializeDoc).join(''));
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

    recordCost(repoKey, iteration, cost) {
      try {
        appendIfOpen(repoKey, [loopCostEvent(cost, iteration, auditTimestamp(now()))]);
      } catch (e) {
        log('audit recordCost failed', e);
      }
    },

    recordAppCost(repoKey, cost) {
      try {
        appendIfOpen(repoKey, [appCostEvent(cost, auditTimestamp(now()))]);
        return true;
      } catch (e) {
        log('audit recordAppCost failed', e);
        return false;
      }
    },

    recordCi(repoKey, iteration, snapshot) {
      try {
        appendIfOpen(repoKey, [
          { ts: auditTimestamp(now()), type: 'loop.ci', iteration, total: snapshot.total, passed: snapshot.passed, failed: snapshot.failed, pending: snapshot.pending },
        ]);
      } catch (e) {
        log('audit recordCi failed', e);
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
        if (file) appendFileSync(file, terminateEvents(auditTimestamp(now())).map(serializeDoc).join(''));
        open.delete(repoKey);
        lastLoop.delete(repoKey);
        rmSync(pointerPath(repoKey), { force: true }); // §25.4 restart-surviving run pointer
      } catch (e) {
        log('audit recordTerminate failed', e);
      }
    },
  };
}
