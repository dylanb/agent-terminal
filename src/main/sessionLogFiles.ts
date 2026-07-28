// §27.11

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { readDirEntriesAsync } from './dirEntries';

/** One session log a run's window admits: where it is, and how big it was when the walk saw it. */
export interface LogFile {
  path: string;
  /** Bytes the log held when the walk saw it; null when it would not stat, which places it on neither
   *  side of the window and leaves the reader to open it and find out. */
  size: number | null;
}

interface LogStamp {
  mtimeMs: number;
  size: number;
}

async function stampOf(file: string): Promise<LogStamp | null> {
  try {
    const s = await fsp.stat(file);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

/** Every `*.jsonl` under `dir` a run whose window opens at `since` could have been written to — the main
 *  session's per-`/clear` segments plus the reviewer-subagent logs under `<session-uuid>/subagents/`
 *  (§26.10). A log whose last write predates the window is skipped before it is opened; an append bumps
 *  the mtime, so a log that predates the window but grew inside it is still admitted. An absent directory
 *  yields nothing and an unreadable one THROWS (`dirEntries`), because a caller that read the second as
 *  the first would price the tree at a confident $0.00. Walks without occupying the main thread (AC 7). */
export async function* logFilesInWindow(dir: string, since?: number): AsyncGenerator<LogFile> {
  for (const entry of await readDirEntriesAsync(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory) {
      yield* logFilesInWindow(full, since);
      continue;
    }
    if (!entry.isFile || !entry.name.endsWith('.jsonl')) continue;
    const stamp = await stampOf(full);
    if (stamp !== null && since !== undefined && stamp.mtimeMs < since) continue;
    yield { path: full, size: stamp === null ? null : stamp.size };
  }
}
