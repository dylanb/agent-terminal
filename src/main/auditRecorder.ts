// The main-process flow audit writer (§25): opens a run file on flow:start and appends lifecycle
// events on later transitions, never throwing into the flow path (best-effort, §25.1/§25.7). The
// vocabulary, path derivation, serialization, and classifier are shared (src/shared/audit) so the
// on-disk format cannot drift from any reader.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  auditTimestamp,
  lifecycleEvents,
  serializeDoc,
  todoEvents,
  type AuditHeader,
  type FlowLike,
  type TodoLike,
  type TransitionKind,
} from '../shared/audit';
import { auditFilePath } from './auditPaths';
import { isRecord } from './yamlRecord';

const POINTER_REL = path.join('.agent-terminal', 'audit-pointer.yaml');
const POINTER_GITIGNORE = '.agent-terminal/audit-pointer.yaml';

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
}

export function createAuditRecorder(deps: AuditRecorderDeps): AuditRecorder {
  const { root, now, flowName } = deps;
  const log = deps.log ?? ((m, e): void => console.error(m, e));
  const open = new Map<string, string>();

  const pointerPath = (repoKey: string): string => path.join(repoKey, POINTER_REL);

  const ensureGitignored = (repoKey: string): void => {
    const file = path.join(repoKey, '.gitignore');
    let existing = '';
    try {
      existing = readFileSync(file, 'utf8');
    } catch {
      existing = '';
    }
    if (existing.split('\n').some((l) => l.trim() === POINTER_GITIGNORE)) return;
    const prefix = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`;
    writeFileSync(file, `${prefix}${POINTER_GITIGNORE}\n`);
  };

  const writePointer = (repoKey: string, file: string): void => {
    const pp = pointerPath(repoKey);
    mkdirSync(path.dirname(pp), { recursive: true });
    writeFileSync(pp, yaml.dump({ file }));
    ensureGitignored(repoKey);
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
          mkdirSync(path.dirname(file), { recursive: true });
          writeFileSync(file, serializeDoc(header) + events.map(serializeDoc).join(''));
          open.set(repoKey, file);
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
        const file = currentFile(repoKey);
        if (!file) return;
        const events = todoEvents(before, after, auditTimestamp(now()));
        if (events.length > 0) appendFileSync(file, events.map(serializeDoc).join(''));
      } catch (e) {
        log('audit recordTodoChange failed', e);
      }
    },
  };
}
