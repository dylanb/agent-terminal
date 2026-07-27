import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encodeProjectDir,
  sessionLogDir,
  readSessionTokens,
  streamSessionTurns,
  type SessionTurn,
} from '../../src/main/sessionLogSweep';

const FLOOR = Date.parse('2026-07-09T12:00:00.000Z');

const turnLine = (opts: {
  ts?: string;
  id?: string;
  model?: string;
  input?: number;
  output?: number;
}): string =>
  JSON.stringify({
    type: 'assistant',
    ...(opts.ts === undefined ? {} : { timestamp: opts.ts }),
    ...(opts.id === undefined ? {} : { requestId: `req-${opts.id}` }),
    message: {
      ...(opts.id === undefined ? {} : { id: `msg-${opts.id}` }),
      model: opts.model ?? 'claude-sonnet-5',
      usage: { input_tokens: opts.input ?? 0, output_tokens: opts.output ?? 0 },
    },
  });

async function drain(dir: string | null, opts?: { since?: number; chunkBytes?: number }): Promise<SessionTurn[]> {
  const out: SessionTurn[] = [];
  for await (const turn of streamSessionTurns(dir, opts)) out.push(turn);
  return out;
}

/** Event-loop turns elapsed, counted by a self-rescheduling macrotask — ordering only, no wall clock. */
function eventLoopTicker(): { ticks: () => number; stop: () => void } {
  let ticks = 0;
  let running = true;
  const pump = (): void => {
    if (!running) return;
    ticks += 1;
    setTimeout(pump, 0);
  };
  setTimeout(pump, 0);
  return { ticks: () => ticks, stop: () => { running = false; } };
}

describe('the §27 per-turn session-log stream', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sweep-stream-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('yields each priced turn with its instant, billing identity and per-model tokens', async () => {
    writeFileSync(
      join(dir, 'session.jsonl'),
      [
        turnLine({ ts: '2026-07-09T12:00:01.000Z', id: 'a', input: 100, output: 20 }),
        turnLine({ ts: '2026-07-09T12:00:02.000Z', id: 'b', model: 'claude-opus-4-8', input: 5 }),
      ].join('\n'),
    );
    const turns = await drain(dir);
    expect(turns).toEqual([
      {
        at: Date.parse('2026-07-09T12:00:01.000Z'),
        id: 'msg-a\x00req-a',
        model: 'claude-sonnet-5',
        input: 100,
        cacheCreate: 0,
        cacheRead: 0,
        output: 20,
      },
      {
        at: Date.parse('2026-07-09T12:00:02.000Z'),
        id: 'msg-b\x00req-b',
        model: 'claude-opus-4-8',
        input: 5,
        cacheCreate: 0,
        cacheRead: 0,
        output: 0,
      },
    ]);
  });

  it('yields the nested reviewer-subagent logs, not only the main session', async () => {
    writeFileSync(join(dir, 'main.jsonl'), turnLine({ ts: '2026-07-09T12:00:01.000Z', id: 'w', input: 10 }));
    const subagents = join(dir, 'session-uuid', 'subagents');
    mkdirSync(subagents, { recursive: true });
    writeFileSync(join(subagents, 'agent-x.jsonl'), turnLine({ ts: '2026-07-09T12:00:02.000Z', id: 'r', output: 40 }));
    const turns = await drain(dir);
    expect(turns.map((t) => t.id).sort()).toEqual(['msg-r\x00req-r', 'msg-w\x00req-w']);
  });

  it('excludes turns before the floor and keeps a turn exactly at it', async () => {
    writeFileSync(
      join(dir, 'session.jsonl'),
      [
        turnLine({ ts: '2026-07-01T00:00:00.000Z', id: 'old', input: 5000 }),
        turnLine({ ts: '2026-07-09T12:00:00.000Z', id: 'edge', input: 7 }),
      ].join('\n'),
    );
    const turns = await drain(dir, { since: FLOOR });
    expect(turns.map((t) => t.input)).toEqual([7]);
  });

  // The §27 stream places every turn by its own instant, so a turn with no usable one belongs to no
  // interval in the run's window. The aggregate entry point drops such a turn only when a lower bound is
  // given; the stream excludes it in BOTH directions, so the no-floor branch cannot admit an unplaceable
  // dollar that the run's parts can never account for.
  it('excludes a turn with no usable instant on the no-floor branch as well as the bounded one', async () => {
    writeFileSync(
      join(dir, 'session.jsonl'),
      [
        turnLine({ ts: 'nonsense', id: 'bad', input: 5000 }),
        turnLine({ id: 'absent', input: 3000 }),
        turnLine({ ts: '2026-07-09T12:00:01.000Z', id: 'ok', input: 7 }),
      ].join('\n'),
    );
    expect((await drain(dir)).map((t) => t.input)).toEqual([7]);
    expect((await drain(dir, { since: FLOOR })).map((t) => t.input)).toEqual([7]);
  });

  it('degrades on drift: an absent dir, an unparseable line and a non-priced line yield no throw', async () => {
    writeFileSync(
      join(dir, 'session.jsonl'),
      [
        'not json {{{',
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
        JSON.stringify({ message: { usage: { input_tokens: 5 } } }),
        turnLine({ ts: '2026-07-09T12:00:01.000Z', id: 'ok', input: 7 }),
        '',
      ].join('\n'),
    );
    writeFileSync(join(dir, 'notes.txt'), turnLine({ ts: '2026-07-09T12:00:01.000Z', id: 'nope', input: 999 }));
    expect((await drain(dir)).map((t) => t.input)).toEqual([7]);
    expect(await drain(join(dir, 'does-not-exist'))).toEqual([]);
    expect(await drain(null)).toEqual([]);
  });

  // AC 7 — "delays" is bound by ordering. (a) the per-directory half: the sweep relinquishes the event loop
  // BETWEEN logs, so work scheduled while a sample is in flight runs before the sample settles. Each file is
  // read in a single chunk here, so only a between-files yield can move the counter.
  it('relinquishes the event loop between logs', async () => {
    for (const name of ['a.jsonl', 'b.jsonl', 'c.jsonl', 'd.jsonl']) {
      writeFileSync(join(dir, name), turnLine({ ts: '2026-07-09T12:00:01.000Z', id: name, input: 1 }));
    }
    const ticker = eventLoopTicker();
    const marks: number[] = [];
    for await (const _turn of streamSessionTurns(dir, { chunkBytes: 1_000_000 })) marks.push(ticker.ticks());
    ticker.stop();
    expect(marks.length).toBe(4);
    expect(marks[marks.length - 1]).toBeGreaterThan(marks[0]);
  });

  // (b) the per-file half: the current session's own log is written during the run by definition and is the
  // largest single file, so no timestamp filter can exclude it. A sweep that yields between files but still
  // reads each one whole leaves the counter frozen across a single log's turns.
  it('relinquishes the event loop WITHIN one log, not merely between logs', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 200; i += 1) lines.push(turnLine({ ts: '2026-07-09T12:00:01.000Z', id: `t${i}`, input: 1 }));
    writeFileSync(join(dir, 'single.jsonl'), lines.join('\n'));
    const ticker = eventLoopTicker();
    const marks: number[] = [];
    for await (const _turn of streamSessionTurns(dir, { chunkBytes: 256 })) marks.push(ticker.ticks());
    ticker.stop();
    expect(marks.length).toBe(200);
    expect(marks[marks.length - 1]).toBeGreaterThan(marks[0]);
  });

  it('reads a turn split across a chunk boundary exactly once', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 40; i += 1) lines.push(turnLine({ ts: '2026-07-09T12:00:01.000Z', id: `s${i}`, input: 1 }));
    writeFileSync(join(dir, 'split.jsonl'), lines.join('\n'));
    const ids = (await drain(dir, { chunkBytes: 37 })).map((t) => t.id);
    expect(new Set(ids).size).toBe(40);
  });

  // The mtime pre-filter is what collapses a 359 MB log root to the handful of files written during the run.
  // The stale file is planted READABLE and carrying in-window turns: an unreadable one is contractually
  // skipped anyway (AC 7), so it could not tell a skipped file from an opened one.
  it('skips a log whose last write predates the floor, and opens it when there is no floor', async () => {
    const stale = join(dir, 'stale.jsonl');
    writeFileSync(stale, turnLine({ ts: '2026-07-09T12:00:05.000Z', id: 'hidden', input: 999 }));
    const before = (FLOOR - 60_000) / 1000;
    utimesSync(stale, before, before);
    writeFileSync(join(dir, 'live.jsonl'), turnLine({ ts: '2026-07-09T12:00:06.000Z', id: 'live', input: 3 }));

    expect((await drain(dir, { since: FLOOR })).map((t) => t.id)).toEqual(['msg-live\x00req-live']);
    expect((await drain(dir)).map((t) => t.id).sort()).toEqual(['msg-hidden\x00req-hidden', 'msg-live\x00req-live']);
  });
});

// The §27 sweep, its log-root resolver and its project-dir encoder have ONE owner that the N8 sweep keeps,
// so deleting §26 whole cannot take §27's log-root resolution or its environment override with it.
describe('the §27-owned log-root resolution', () => {
  it('encodes a repo path into Claude Code`s project-dir name', () => {
    expect(encodeProjectDir('/Users/x/src/agent-terminal.one')).toBe('-Users-x-src-agent-terminal-one');
  });

  it('resolves the exact-directory override, and ~/.claude/projects/<encoded-repo> without one', () => {
    expect(sessionLogDir('/repo', { APP_SESSION_LOG_ROOT: '/tmp/logs' } as NodeJS.ProcessEnv, '/home')).toBe('/tmp/logs');
    expect(sessionLogDir('/repo/foo', {} as NodeJS.ProcessEnv, '/home/me')).toBe(
      join('/home/me', '.claude', 'projects', '-repo-foo'),
    );
  });

  // The config-root branch already refuses a relative override; the exact-directory branch returned it
  // verbatim, anchoring §27's only log-root seam to the process cwd.
  it('refuses a RELATIVE exact-directory override rather than anchoring it at the cwd', async () => {
    expect(sessionLogDir('/repo', { APP_SESSION_LOG_ROOT: 'relative/logs' } as NodeJS.ProcessEnv, '/home')).toBeNull();
    expect(await drain(sessionLogDir('/repo', { APP_SESSION_LOG_ROOT: 'rel' } as NodeJS.ProcessEnv, '/home'))).toEqual([]);
  });

  it('refuses a relative CLAUDE_CONFIG_DIR, and still resolves an absolute one', () => {
    expect(sessionLogDir('/repo/foo', { CLAUDE_CONFIG_DIR: 'relative/cfg' } as NodeJS.ProcessEnv, '/home/me')).toBeNull();
    expect(sessionLogDir('/repo/foo', { CLAUDE_CONFIG_DIR: '/cfg' } as NodeJS.ProcessEnv, '/home/me')).toBe(
      join('/cfg', 'projects', '-repo-foo'),
    );
  });
});

// AC 10 — the aggregate entry point §26 calls synchronously keeps its behaviour, including the one the §27
// stream deliberately differs on: with no lower bound every turn counts, timestamped or not.
describe('the aggregate entry point §26 still calls', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sweep-aggregate-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('counts an un-timestamped turn when no lower bound is given', () => {
    writeFileSync(
      join(dir, 'session.jsonl'),
      [turnLine({ ts: '2026-07-01T00:00:00.000Z', input: 5000 }), turnLine({ ts: 'nonsense', input: 7 })].join('\n'),
    );
    expect(readSessionTokens(dir)[0].input).toBe(5007);
  });

  it('opens a log whose mtime predates the bound — the pre-filter is the stream`s, not the aggregate`s', () => {
    const stale = join(dir, 'stale.jsonl');
    writeFileSync(stale, turnLine({ ts: '2026-07-09T12:00:05.000Z', input: 11 }));
    const before = (FLOOR - 60_000) / 1000;
    utimesSync(stale, before, before);
    expect(readSessionTokens(dir, FLOOR)[0].input).toBe(11);
  });
});
