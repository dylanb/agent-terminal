import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logFilesInWindow, type LogFile } from '../../src/main/sessionLogFiles';
import { ticksDuring } from '../helpers/eventLoop';

const FLOOR = Date.parse('2026-07-09T12:00:00.000Z');

async function walk(dir: string, since?: number): Promise<LogFile[]> {
  const out: LogFile[] = [];
  for await (const file of logFilesInWindow(dir, since)) out.push(file);
  return out;
}

async function names(dir: string, since?: number): Promise<string[]> {
  return (await walk(dir, since)).map((f) => f.path.slice(dir.length + 1)).sort();
}

function stampedAt(file: string, ms: number): void {
  utimesSync(file, ms / 1000, ms / 1000);
}

describe('which session logs are in a run`s window', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'log-files-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds the nested reviewer-subagent logs, not only the main session`s', async () => {
    writeFileSync(join(dir, 'main.jsonl'), 'a\n');
    mkdirSync(join(dir, 'session-uuid', 'subagents'), { recursive: true });
    writeFileSync(join(dir, 'session-uuid', 'subagents', 'agent-x.jsonl'), 'b\n');
    expect(await names(dir)).toEqual(['main.jsonl', join('session-uuid', 'subagents', 'agent-x.jsonl')]);
  });

  it('passes over a file that is not a session log', async () => {
    writeFileSync(join(dir, 'session.jsonl'), 'a\n');
    writeFileSync(join(dir, 'notes.txt'), 'b\n');
    expect(await names(dir)).toEqual(['session.jsonl']);
  });

  it('reports the bytes each log held when the walk saw it', async () => {
    writeFileSync(join(dir, 'session.jsonl'), 'hello\n');
    expect((await walk(dir))[0].size).toBe(6);
  });

  it('finds nothing under a directory that does not exist', async () => {
    expect(await walk(join(dir, 'absent'))).toEqual([]);
  });

  // CLAUDE.md § dirEntries — absent yields nothing, unreadable THROWS. Conflating them prices an
  // enumerable-but-unreadable log root at a confident $0.00.
  it('raises rather than reporting nothing when the root exists but refuses enumeration', async () => {
    const notADir = join(dir, 'regular-file');
    writeFileSync(notADir, 'not a directory');
    await expect(walk(notADir)).rejects.toThrow();
  });

  it.skipIf(process.getuid?.() === 0)('raises when a nested subagent directory refuses enumeration', async () => {
    writeFileSync(join(dir, 'main.jsonl'), 'a\n');
    const locked = join(dir, 'session-uuid');
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    try {
      await expect(walk(dir)).rejects.toThrow();
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  // The project dir accumulates every Claude Code session ever logged against the worktree, so on a
  // long-lived repo the great majority of the tree is prior sessions the window rejects turn by turn.
  it('passes over a log whose last write predates the window, and opens it when there is none', async () => {
    const stale = join(dir, 'stale.jsonl');
    writeFileSync(stale, 'old\n');
    stampedAt(stale, FLOOR - 60_000);
    writeFileSync(join(dir, 'live.jsonl'), 'new\n');

    expect(await names(dir, FLOOR)).toEqual(['live.jsonl']);
    expect(await names(dir)).toEqual(['live.jsonl', 'stale.jsonl']);
  });

  // An append bumps the mtime, so a log that existed before the run but grew during it is in the window.
  it('keeps a log that predates the window but was written to inside it', async () => {
    const grown = join(dir, 'grown.jsonl');
    writeFileSync(grown, 'old\n');
    stampedAt(grown, FLOOR + 60_000);
    expect(await names(dir, FLOOR)).toEqual(['grown.jsonl']);
  });

  // A log that will not stat cannot be placed on either side of the window, and excluding it would drop
  // the run's dollars silently. It is handed on with no size, so the reader opens it and finds out.
  it('hands on a log it cannot stat, with no size, on both the bounded and unbounded branches', async () => {
    symlinkSync(join(dir, 'no-such-target'), join(dir, 'dangling.jsonl'));
    for (const since of [undefined, FLOOR]) {
      const files = await walk(dir, since);
      expect(files.map((f) => f.path)).toEqual([join(dir, 'dangling.jsonl')]);
      expect(files[0].size).toBeNull();
    }
  });

  // AC 7 — "delays" is bound by ordering: work scheduled while the walk is in flight runs before it
  // settles, so a synchronous enumeration of a project dir holding hundreds of logs cannot pass.
  it('relinquishes the event loop while enumerating', async () => {
    for (let i = 0; i < 12; i += 1) writeFileSync(join(dir, `s${i}.jsonl`), 'x\n');
    expect(await ticksDuring(() => walk(dir))).toBeGreaterThan(1);
  });
});
