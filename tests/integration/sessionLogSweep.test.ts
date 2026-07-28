import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  utimesSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeProjectDir, sessionLogDir, readSessionTokens, openSessionSweep, type SessionSweep } from '../../src/main/sessionLogSweep';
import { priceTokens, type ModelTokens } from '../../src/shared/pricing';
import { ticksDuring } from '../helpers/eventLoop';

const FLOOR = Date.parse('2026-07-09T12:00:00.000Z');
const CHUNK = 64 * 1024;

const turnLine = (opts: {
  ts?: string;
  id?: string;
  msgId?: string;
  reqId?: string;
  model?: string;
  input?: number;
  output?: number;
}): string =>
  JSON.stringify({
    type: 'assistant',
    ...(opts.ts === undefined ? {} : { timestamp: opts.ts }),
    ...(opts.reqId !== undefined
      ? { requestId: opts.reqId }
      : opts.id === undefined
        ? {}
        : { requestId: `req-${opts.id}` }),
    message: {
      ...(opts.msgId !== undefined ? { id: opts.msgId } : opts.id === undefined ? {} : { id: `msg-${opts.id}` }),
      model: opts.model ?? 'claude-sonnet-5',
      usage: { input_tokens: opts.input ?? 0, output_tokens: opts.output ?? 0 },
    },
  });

/** A session log's bytes: every line newline-terminated, as Claude Code writes them. */
const logBytes = (...lines: string[]): string => `${lines.join('\n')}\n`;

function sweepOf(dir: string | null, opts?: { since?: number; chunkBytes?: number }): SessionSweep {
  return openSessionSweep(dir, {
    chunkBytes: opts?.chunkBytes ?? CHUNK,
    ...(opts?.since === undefined ? {} : { since: opts.since }),
  });
}

const inputOf = (totals: ModelTokens[]): number => totals.reduce((n, t) => n + t.input, 0);

describe('the §27 session-log sweep', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sweep-stream-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('folds the window`s priced turns into per-model totals', async () => {
    writeFileSync(
      join(dir, 'session.jsonl'),
      logBytes(
        turnLine({ ts: '2026-07-09T12:00:01.000Z', id: 'a', input: 100, output: 20 }),
        turnLine({ ts: '2026-07-09T12:00:02.000Z', id: 'b', model: 'claude-opus-4-8', input: 5 }),
      ),
    );
    expect(await sweepOf(dir).drain()).toEqual([
      { model: 'claude-opus-4-8', input: 5, cacheCreate: 0, cacheRead: 0, output: 0 },
      { model: 'claude-sonnet-5', input: 100, cacheCreate: 0, cacheRead: 0, output: 20 },
    ]);
  });

  // AC 1 — the run's total covers every reviewer subagent, whose logs are nested under the session dir.
  it('reaches the nested reviewer-subagent logs, not only the main session`s', async () => {
    writeFileSync(join(dir, 'main.jsonl'), logBytes(turnLine({ ts: '2026-07-09T12:00:01.000Z', id: 'w', input: 10 })));
    const subagents = join(dir, 'session-uuid', 'subagents');
    mkdirSync(subagents, { recursive: true });
    writeFileSync(join(subagents, 'agent-x.jsonl'), logBytes(turnLine({ ts: '2026-07-09T12:00:02.000Z', id: 'r', input: 40 })));
    expect(inputOf(await sweepOf(dir).drain())).toBe(50);
  });

  // AC 2 — the sweep is bounded below by the flow's recorded start.
  it('excludes turns before the floor and keeps one exactly at it', async () => {
    writeFileSync(
      join(dir, 'session.jsonl'),
      logBytes(
        turnLine({ ts: '2026-07-01T00:00:00.000Z', id: 'old', input: 5000 }),
        turnLine({ ts: '2026-07-09T12:00:00.000Z', id: 'edge', input: 7 }),
      ),
    );
    expect(inputOf(await sweepOf(dir, { since: FLOOR }).drain())).toBe(7);
  });

  // AC 3 — a resumed or forked session replays prior turns verbatim into a second file, at a later log
  // time and in a different position. The API billed them once.
  it('counts a billed turn once when it is replayed into a second log', async () => {
    const replayed = turnLine({ ts: '2026-07-09T12:00:01.000Z', id: 'work', input: 1000 });
    writeFileSync(join(dir, 'session.jsonl'), logBytes(replayed, turnLine({ ts: '2026-07-09T12:00:02.000Z', id: 'other', input: 5 })));
    writeFileSync(join(dir, 'resumed.jsonl'), logBytes(replayed));
    expect(inputOf(await sweepOf(dir, { since: FLOOR }).drain())).toBe(1005);
  });

  it('degrades on drift: an absent dir, a refused root, an unparseable line and a non-log file', async () => {
    writeFileSync(
      join(dir, 'session.jsonl'),
      logBytes('not json {{{', JSON.stringify({ type: 'user', message: { role: 'user' } }), turnLine({ ts: '2026-07-09T12:00:01.000Z', id: 'ok', input: 7 })),
    );
    writeFileSync(join(dir, 'notes.txt'), logBytes(turnLine({ ts: '2026-07-09T12:00:01.000Z', id: 'nope', input: 999 })));
    expect(inputOf(await sweepOf(dir).drain())).toBe(7);
    expect(await sweepOf(join(dir, 'does-not-exist')).drain()).toEqual([]);
  });

  // A REFUSED root is the one case where the meter KNOWS it cannot see the logs, and it is the only path
  // that used to fabricate a figure from that: empty totals price to `$0.00`, character-for-character what
  // a genuinely-zero run reports, and that zero reaches the append-only §25 record. It lands on the same
  // loud branch as the unreadable root two lines above, which `appCostMeter.sample` degrades safely
  // without touching the run (CWE-755).
  it('throws rather than pricing a run at a confident $0.00 when the log root is refused', async () => {
    await expect(sweepOf(null).drain()).rejects.toThrow();
    await expect(sweepOf(null, { since: FLOOR }).drain()).rejects.toThrow();
  });

  // CLAUDE.md § dirEntries — absent yields nothing, unreadable THROWS. Conflating them prices an
  // enumerable-but-unreadable log root at a confident $0.00 and persists that into the run's §25 record.
  it('throws rather than reporting nothing when the log root exists but cannot be enumerated', async () => {
    const notADir = join(dir, 'regular-file');
    writeFileSync(notADir, 'this is not a directory');
    await expect(sweepOf(notADir).drain()).rejects.toThrow();
  });

  // The turns read before the walk aborted are the run's dollars, already counted: the sweep neither loses
  // them nor counts them a second time when the tree becomes readable again.
  it.skipIf(process.getuid?.() === 0)('keeps what it read before an unreadable directory aborted the walk, and counts it once', async () => {
    writeFileSync(join(dir, 'a.jsonl'), logBytes(turnLine({ ts: '2026-07-09T12:00:01.000Z', id: 'a', input: 1 })));
    const locked = join(dir, 'locked');
    mkdirSync(locked);
    writeFileSync(join(locked, 'b.jsonl'), logBytes(turnLine({ ts: '2026-07-09T12:00:02.000Z', id: 'b', input: 2 })));
    chmodSync(locked, 0o000);
    const sweep = sweepOf(dir);
    try {
      await expect(sweep.drain()).rejects.toThrow();
    } finally {
      chmodSync(locked, 0o755);
    }
    expect(inputOf(await sweep.drain())).toBe(3);
  });

  // The stale file is planted READABLE and carrying in-window turns: an unreadable one is contractually
  // skipped anyway (AC 7), so it could not tell a skipped file from an opened one.
  it('skips a log whose last write predates the floor, and opens it when there is no floor', async () => {
    const stale = join(dir, 'stale.jsonl');
    writeFileSync(stale, logBytes(turnLine({ ts: '2026-07-09T12:00:05.000Z', id: 'hidden', input: 999 })));
    const before = (FLOOR - 60_000) / 1000;
    utimesSync(stale, before, before);
    writeFileSync(join(dir, 'live.jsonl'), logBytes(turnLine({ ts: '2026-07-09T12:00:06.000Z', id: 'live', input: 3 })));

    expect(inputOf(await sweepOf(dir, { since: FLOOR }).drain())).toBe(3);
    expect(inputOf(await sweepOf(dir).drain())).toBe(1002);
  });

  // AC 7 — "delays" is bound by ordering: a probe scheduled while a sample is in flight runs before that
  // sample settles. The current session's own log is written during the run by definition and is the
  // largest single file, so no window filter can exclude it — a sweep that yields between logs but reads
  // each one whole leaves the counter frozen across a single log's turns.
  it('relinquishes the event loop within one log, more the smaller the chunk', async () => {
    writeFileSync(
      join(dir, 'single.jsonl'),
      logBytes(...Array.from({ length: 200 }, (_, i) => turnLine({ ts: '2026-07-09T12:00:01.000Z', id: `t${i}`, input: 1 }))),
    );
    const ticksFor = (chunkBytes: number): Promise<number> => ticksDuring(() => sweepOf(dir, { chunkBytes }).drain());
    const chunked = await ticksFor(256);
    const whole = await ticksFor(4_000_000);
    expect(chunked).toBeGreaterThan(whole);
    expect(chunked).toBeGreaterThan(20);
  });
});

// The run's own logs are the ones the mtime floor can never exclude — they are written during the run by
// definition — so a sweep with no memory re-opens, re-reads and re-parses every one of them, whole, every
// two seconds for the life of the run, on the process that also drains the PTY.
describe('the §27 sweep`s memory across drains', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sweep-cursor-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports the same figure on a second drain when no log changed', async () => {
    writeFileSync(join(dir, 'a.jsonl'), logBytes(turnLine({ ts: '2026-07-09T12:00:01.000Z', id: 'a', input: 1 })));
    writeFileSync(join(dir, 'b.jsonl'), logBytes(turnLine({ ts: '2026-07-09T12:00:02.000Z', id: 'b', input: 2 })));
    const sweep = sweepOf(dir);
    expect(inputOf(await sweep.drain())).toBe(3);
    expect(inputOf(await sweep.drain())).toBe(3);
  });

  it('adds what a log gained, and nothing it had already read', async () => {
    const grown = join(dir, 'grows.jsonl');
    writeFileSync(join(dir, 'still.jsonl'), logBytes(turnLine({ ts: '2026-07-09T12:00:01.000Z', id: 'still', input: 1 })));
    writeFileSync(grown, logBytes(turnLine({ ts: '2026-07-09T12:00:02.000Z', id: 'one', input: 2 })));
    const sweep = sweepOf(dir);
    expect(inputOf(await sweep.drain())).toBe(3);

    appendFileSync(grown, logBytes(turnLine({ ts: '2026-07-09T12:00:03.000Z', id: 'two', input: 4 })));
    expect(inputOf(await sweep.drain())).toBe(7);
  });

  // A sample can still be walking the tree when the next one is armed — `pushWindow` re-arms whenever the
  // pushed triple changes, and a chain advance changes the loop name while keeping the run and its sweep —
  // so two drains of one sweep can overlap. Both would start from the same read position and fold the same
  // bytes twice; the identity memory hides that for a turn the log identifies, and not for one it does not.
  it('counts each turn once when two drains of one sweep overlap', async () => {
    writeFileSync(
      join(dir, 'session.jsonl'),
      logBytes(
        turnLine({ ts: '2026-07-09T12:00:01.000Z', input: 100 }),
        turnLine({ ts: '2026-07-09T12:00:02.000Z', id: 'identified', input: 20 }),
      ),
    );
    const sweep = sweepOf(dir, { chunkBytes: 16 });
    const [first, second] = await Promise.all([sweep.drain(), sweep.drain()]);
    expect(inputOf(first)).toBe(120);
    expect(inputOf(second)).toBe(120);
    expect(inputOf(await sweep.drain())).toBe(120);
  });

  it('picks up a log created after the first drain', async () => {
    writeFileSync(join(dir, 'a.jsonl'), logBytes(turnLine({ ts: '2026-07-09T12:00:01.000Z', id: 'a', input: 1 })));
    const sweep = sweepOf(dir);
    expect(inputOf(await sweep.drain())).toBe(1);

    writeFileSync(join(dir, 'b.jsonl'), logBytes(turnLine({ ts: '2026-07-09T12:00:02.000Z', id: 'b', input: 2 })));
    expect(inputOf(await sweep.drain())).toBe(3);
  });

  // A log rewritten under the sweep is not an append: what the sweep remembers of it is worthless, and the
  // dollars it already counted stand — the API billed them.
  it('re-reads a log that was rewritten smaller rather than trusting its memory of it', async () => {
    const log = join(dir, 'rotated.jsonl');
    writeFileSync(
      log,
      logBytes(
        turnLine({ ts: '2026-07-09T12:00:01.000Z', id: 'one', input: 1 }),
        turnLine({ ts: '2026-07-09T12:00:02.000Z', id: 'two', input: 2 }),
      ),
    );
    const sweep = sweepOf(dir);
    expect(inputOf(await sweep.drain())).toBe(3);

    writeFileSync(log, logBytes(turnLine({ ts: '2026-07-09T12:00:03.000Z', id: 'fresh', input: 4 })));
    expect(inputOf(await sweep.drain())).toBe(7);
  });

  // AC 9's shape at this layer — read positions live in memory, so a relaunch mid-run rebuilds the figure
  // with ONE catch-up pass from the flow's recorded start and streams from there. A catch-up pass is
  // correct; a REPEATING one is the defect this sweep exists to remove.
  it('rebuilds the whole figure on a fresh sweep over the same logs, then adds nothing', async () => {
    writeFileSync(
      join(dir, 'session.jsonl'),
      logBytes(
        turnLine({ ts: '2026-07-09T12:00:01.000Z', id: 'a', input: 1 }),
        turnLine({ ts: '2026-07-09T12:00:02.000Z', id: 'b', input: 2 }),
      ),
    );
    expect(inputOf(await sweepOf(dir, { since: FLOOR }).drain())).toBe(3);

    const relaunched = sweepOf(dir, { since: FLOOR });
    expect(inputOf(await relaunched.drain())).toBe(3);
    expect(inputOf(await relaunched.drain())).toBe(3);
  });

  // A flow that terminates and a different one that starts must inherit neither the totals nor the read
  // positions: the second run would otherwise report the first run's dollars, or only the tail of a log
  // the first run had already reached.
  it('drops its totals and its read positions when the run it was opened for is released', async () => {
    writeFileSync(join(dir, 'session.jsonl'), logBytes(turnLine({ ts: '2026-07-09T12:00:01.000Z', id: 'a', input: 3 })));
    const sweep = sweepOf(dir);
    expect(inputOf(await sweep.drain())).toBe(3);

    sweep.close();
    expect(await sweep.drain()).toEqual([{ model: 'claude-sonnet-5', input: 3, cacheCreate: 0, cacheRead: 0, output: 0 }]);
  });

  // The release is reachable WHILE a walk is running: a floor change opens the replacement sweep and
  // releases the previous one mid-catch-up. An orphan walk keeps calling into the stream, and the stream
  // writes a read position back for every log it finishes — repopulating the map the release just cleared,
  // so the released sweep resumes from positions belonging to a run that is over and reads nothing.
  it('re-reads every log from the top when it is released while a drain is in flight', async () => {
    for (let i = 0; i < 6; i += 1) {
      writeFileSync(
        join(dir, `s${i}.jsonl`),
        logBytes(turnLine({ ts: '2026-07-09T12:00:01.000Z', id: `a${i}`, input: 1 })),
      );
    }
    const sweep = sweepOf(dir, { chunkBytes: 8 });
    const inFlight = sweep.drain();
    sweep.close();
    await inFlight;

    expect(inputOf(await sweep.drain())).toBe(6);
  });

  // ...and the totals the released run accumulated are not what the next drain answers with: `close()`
  // orphans the fold, so a drain issued while one is still in flight must walk for the FRESH ledger rather
  // than be handed the retired run's promise. Deleting a log the retired run already counted separates the
  // two answers — a fresh walk of the tree can no longer reach those dollars, and the retired ledger still
  // holds them.
  it('never answers a drain issued after the release with the released run`s totals', async () => {
    writeFileSync(join(dir, 'a.jsonl'), logBytes(turnLine({ ts: '2026-07-09T12:00:01.000Z', id: 'a', input: 3 })));
    const gone = join(dir, 'b.jsonl');
    writeFileSync(gone, logBytes(turnLine({ ts: '2026-07-09T12:00:02.000Z', id: 'b', input: 5 })));
    const sweep = sweepOf(dir, { chunkBytes: 8 });
    expect(inputOf(await sweep.drain())).toBe(8);

    rmSync(gone);
    const inFlight = sweep.drain();
    sweep.close();
    const after = sweep.drain();
    await inFlight;

    expect(inputOf(await after)).toBe(3);
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
    await expect(sweepOf(sessionLogDir('/repo', { APP_SESSION_LOG_ROOT: 'rel' } as NodeJS.ProcessEnv, '/home')).drain()).rejects.toThrow();
  });

  it('refuses a relative CLAUDE_CONFIG_DIR, and still resolves an absolute one', () => {
    expect(sessionLogDir('/repo/foo', { CLAUDE_CONFIG_DIR: 'relative/cfg' } as NodeJS.ProcessEnv, '/home/me')).toBeNull();
    expect(sessionLogDir('/repo/foo', { CLAUDE_CONFIG_DIR: '/cfg' } as NodeJS.ProcessEnv, '/home/me')).toBe(
      join('/cfg', 'projects', '-repo-foo'),
    );
  });
});

// AC 10 — the aggregate entry point §26 calls synchronously keeps its behaviour, including the one the §27
// sweep deliberately differs on: with no lower bound every turn counts, timestamped or not.
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

  it('opens a log whose mtime predates the bound — the pre-filter is the sweep`s, not the aggregate`s', () => {
    const stale = join(dir, 'stale.jsonl');
    writeFileSync(stale, turnLine({ ts: '2026-07-09T12:00:05.000Z', input: 11 }));
    const before = (FLOOR - 60_000) / 1000;
    utimesSync(stale, before, before);
    expect(readSessionTokens(dir, FLOOR)[0].input).toBe(11);
  });

  it('reports an unreadable log root as no tokens, exactly as it does today', () => {
    const notADir = join(dir, 'regular-file');
    writeFileSync(notADir, 'this is not a directory');
    expect(readSessionTokens(notADir)).toEqual([]);
  });

  // AC 10 — every §27 admission rule sits on the §27 fold, so the decoder both engines share is
  // `origin/main`'s byte for byte. Each of the three below is a §26-observable value the sweep's own
  // window bounds and the aggregate deliberately does not.
  it('reports a model id exactly as the log stamps it, however long', () => {
    const long = `claude-${'x'.repeat(500)}`;
    writeFileSync(join(dir, 'session.jsonl'), turnLine({ ts: '2026-07-09T12:00:01.000Z', model: long, input: 12 }));
    expect(readSessionTokens(dir)).toEqual([{ model: long, input: 12, cacheCreate: 0, cacheRead: 0, output: 0 }]);
  });

  it('reports an out-of-range usage count exactly as it reads it', () => {
    writeFileSync(join(dir, 'session.jsonl'), turnLine({ ts: '2026-07-09T12:00:01.000Z', input: -5, output: 1e308 }));
    expect(readSessionTokens(dir)).toEqual([
      { model: 'claude-sonnet-5', input: -5, cacheCreate: 0, cacheRead: 0, output: 1e308 },
    ]);
  });

  // The regression the §27 identity cap introduced when it sat on the shared decoder: a rejected identity
  // reads as an ABSENT one here, and an absent identity skips the dedup block entirely — so a resumed
  // session's replayed turn was counted once per file it appeared in, doubling the run's §26 dollars.
  it('counts a replayed turn once however long its billing identity is', () => {
    const long = 'x'.repeat(254);
    const replay = turnLine({ ts: '2026-07-09T12:00:01.000Z', msgId: long, reqId: long, input: 1000 });
    writeFileSync(join(dir, 'session.jsonl'), replay);
    writeFileSync(join(dir, 'resumed.jsonl'), replay);
    expect(readSessionTokens(dir)[0].input).toBe(1000);
  });

  // AC 4 / AC 10 — §26's aggregate leaves an out-of-range count unclamped, so the finiteness guard that
  // keeps `usd` priceable belongs to pricing and must not zero the correctly-priced dollars beside it.
  it('prices an out-of-range §26 total as an unpriced gap rather than as a confident $0.00', () => {
    writeFileSync(join(dir, 'session.jsonl'), turnLine({ ts: '2026-07-09T12:00:01.000Z', input: -5, output: 1e308 }));
    expect(priceTokens(readSessionTokens(dir))).toEqual({ usd: 0, unpricedModels: ['claude-sonnet-5'] });
  });
});
