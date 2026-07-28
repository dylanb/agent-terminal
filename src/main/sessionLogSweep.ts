// The session-JSONL layout is Claude Code's PRIVATE format — an external dependency the app does not
// control (§27.11).

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { addTokens, sortedTotals, type ModelTokens } from '../shared/pricing';
import { logFilesInWindow } from './sessionLogFiles';
import { createLogStream } from './sessionLogStream';
import { createRunTotals, parseTurnLine } from './sessionLogRecords';
import { userConfigRootFrom } from './userConfig';

/** Encode a repo path into Claude Code's project-dir name: every non-alphanumeric → `-`. */
export function encodeProjectDir(repoPath: string): string {
  return repoPath.replace(/[^A-Za-z0-9]/g, '-');
}

/** The directory the repo's session JSONL logs live in. `APP_SESSION_LOG_ROOT` overrides it with an EXACT
 *  directory (the test seam, where the fake-agent writes its fixtures); otherwise it hangs off the same
 *  user-config root the installer seeds, so a CLAUDE_CONFIG_DIR redirect moves both together. A RELATIVE
 *  override is refused on BOTH branches: Claude Code is a separate process with its own cwd, so a relative
 *  value has no single meaning and anchoring it at ours reads a directory nobody writes (CWE-829). */
export function sessionLogDir(repoPath: string, env: NodeJS.ProcessEnv, home: string): string | null {
  const override = env.APP_SESSION_LOG_ROOT;
  if (override && override.length > 0) return path.isAbsolute(override) ? override : null;
  const root = userConfigRootFrom(env, home);
  return root === null ? null : path.join(root, 'projects', encodeProjectDir(repoPath));
}

/** Every `*.jsonl` under `dir`, recursively — the main session's per-`/clear` segments at the top level plus
 *  the reviewer-subagent logs under `<session-uuid>/subagents/`. An unreadable directory yields none. */
function jsonlFiles(dir: string): string[] {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsonlFiles(full));
    else if (e.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

/** Sum per-model token totals from the session logs under `logDir` — the main session's per-`/clear` segments
 *  plus the reviewer-subagent logs (§26.10). Sorted by model for a stable result.
 *
 *  `since` (epoch ms) bounds the sweep to turns at or after that instant — the flow's start, so the readout is
 *  THIS run's cost and not the repo's lifetime spend, whose sessions share the same project dir. A turn whose
 *  timestamp is missing or unparseable cannot be placed in the run and is excluded once a bound is given.
 *
 *  A turn is counted ONCE per `message.id`+`requestId`: Claude Code writes one record per content block of an
 *  assistant message and repeats that message's whole usage on each, and the API bills it once.
 *
 *  Never throws: a refused root (`null`), an absent dir, an unreadable file, or an unparseable line is
 *  skipped — cost is display-only and must never abort the loop. */
export function readSessionTokens(logDir: string | null, since?: number): ModelTokens[] {
  if (logDir === null) return [];
  const byModel = new Map<string, ModelTokens>();
  const counted = new Set<string>();
  for (const file of jsonlFiles(logDir)) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const turn = parseTurnLine(line);
      if (!turn) continue;
      if (since !== undefined && !(turn.at >= since)) continue;
      if (turn.id !== null) {
        if (counted.has(turn.id)) continue;
        counted.add(turn.id);
      }
      addTokens(byModel, turn);
    }
  }
  return sortedTotals(byModel);
}

export interface SessionSweepOptions {
  /** Epoch ms the run's window opens at; absent sweeps unbounded. */
  since?: number;
  /** How much of a log is read before the sweep relinquishes the event loop (§27.11 / AC 7). */
  chunkBytes: number;
}

/** A sweep of ONE run's window over a repo's session logs (§27.11), composed of the three concerns each
 *  drain moves through: which logs are in the window, what each has gained since it was last read, and how
 *  a line folds into the run's totals. Every drift the private log format can produce degrades — an absent
 *  root, an unreadable file, an unparseable or over-long line — but a REFUSED root, a root that exists and
 *  refuses enumeration, and a chunk size that cannot be allocated all THROW, because a caller that read any
 *  of them as empty would price the run at a confident $0.00. */
export interface SessionSweep {
  /** Consume everything the run's logs have gained, and answer the run's per-model totals so far. A drain
   *  begun while one is still in flight answers with that one rather than walking the tree a second time
   *  from the same read positions. */
  drain(): Promise<ModelTokens[]>;
  /** Release the read positions and the totals. The run they were accumulated for is over: a drain already
   *  in flight is fenced off, so neither its fold nor the read positions it would leave behind reach the
   *  ledger the next drain answers from. */
  close(): void;
}

/** Open a sweep over `logDir` for a run window opening at `options.since` (§27.11). Read positions live in
 *  memory, so a relaunch mid-run rebuilds the figure with one catch-up pass from the flow's recorded start
 *  and streams from there. */
export function openSessionSweep(logDir: string | null, options: SessionSweepOptions): SessionSweep {
  const stream = createLogStream(options.chunkBytes);
  let totals = createRunTotals(options.since);
  let inFlight: Promise<ModelTokens[]> | null = null;
  let generation = 0;

  const walk = async (): Promise<ModelTokens[]> => {
    const mine = generation;
    const run = totals;
    if (logDir === null) throw new Error('session log root refused');
    for await (const file of logFilesInWindow(logDir, options.since)) {
      if (generation !== mine) return run.totals();
      for await (const line of stream.lines(file)) run.fold(line);
    }
    return run.totals();
  };

  return {
    drain(): Promise<ModelTokens[]> {
      inFlight ??= walk().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },

    close(): void {
      generation += 1;
      inFlight = null;
      stream.forget();
      totals = createRunTotals(options.since);
    },
  };
}
