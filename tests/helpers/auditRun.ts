// The §25 audit fixture for A3 (#134) lifecycle tests: a real recorder on a temp audit root with a stepping fake
// clock, so each opened run gets its own file. Run files are found through the recorder's own resolver
// (auditRepoDir), never a date-built literal, so asserting an event is absent can only mean it was not written.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createAuditRecorder, type AuditRecorder } from '../../src/main/auditRecorder';
import { auditRepoDir } from '../../src/main/auditPaths';
import { parseAuditStream, type AuditEvent, type FlowLike } from '../../src/shared/audit';

const CLOCK_BASE_MS = Date.parse('2026-09-24T12:00:00.000Z');
const CLOCK_STEP_MS = 1_000;

export interface AuditRunFixture {
  root: string;
  recorder: AuditRecorder;
  /** Open a run for `worktree` as a real Start does (the recorder's `start` transition). */
  openRun(worktree: string, before: FlowLike, after: FlowLike): void;
  /** Every run file the recorder opened for `worktree`, however it was opened, oldest first. */
  runFiles(worktree: string): string[];
  /** The most recently opened run's file. Throws when no run was opened. */
  runFile(worktree: string): string;
  /** Run `run`'s event types in order (default: the latest run). Throws when that run file does not exist, or
   *  when any of its documents fails to parse (parseAuditStream would silently drop it and everything after). */
  eventTypes(worktree: string, run?: number): AuditEvent['type'][];
}

export function createAuditRunFixture(root: string, flowName: string): AuditRunFixture {
  let ticks = 0;
  const now = (): Date => new Date(CLOCK_BASE_MS + CLOCK_STEP_MS * ticks++);
  const recorder = createAuditRecorder({ root, now, flowName: () => flowName });
  const runFiles = (worktree: string): string[] => {
    const dir = auditRepoDir(root, worktree);
    return existsSync(dir) ? readdirSync(dir).sort().map((name) => join(dir, name)) : [];
  };
  const runFile = (worktree: string, run?: number): string => {
    const files = runFiles(worktree);
    const file = files[run ?? files.length - 1];
    if (file === undefined) throw new Error(`no audit run ${run ?? 'opened'} for ${worktree}`);
    return file;
  };

  return {
    root,
    recorder,
    openRun(worktree, before, after) {
      const prior = runFiles(worktree).length;
      recorder.recordTransition(worktree, 'start', before, after);
      const created = runFiles(worktree).length - prior;
      if (created !== 1) throw new Error(`opening a run created ${created} audit files, not 1`);
    },
    runFiles,
    runFile: (worktree) => runFile(worktree),
    eventTypes(worktree, run) {
      const file = runFile(worktree, run);
      const text = readFileSync(file, 'utf8');
      const { header, events } = parseAuditStream(text);
      const documents = text.split('\n').filter((line) => line === '---').length;
      if (header === null || events.length !== documents - 1) {
        throw new Error(`${file} has ${documents} documents but only ${events.length} events parse after its header`);
      }
      return events.map((e) => e.type);
    },
  };
}
