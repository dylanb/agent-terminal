import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
  utimesSync,
  rmSync,
} from 'node:fs';
import { constants as bufferConstants } from 'node:buffer';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encodeProjectDir,
  sessionLogDir,
  readSessionTokens,
  openSessionSweep,
  MAX_IDENTITY_CHARS,
  type PricedTurn,
  type SessionSweep,
} from '../../src/main/sessionLogSweep';
import { priceTokens } from '../../src/shared/pricing';

const FLOOR = Date.parse('2026-07-09T12:00:00.000Z');
const CHUNK = 64 * 1024;
const billed = (id: string): string => JSON.stringify([`msg-${id}`, `req-${id}`]);

const turnLine = (opts: {
  ts?: string;
  id?: string;
  msgId?: string;
  reqId?: string;
  model?: string;
  input?: number;
  output?: number;
  pad?: number;
}): string =>
  JSON.stringify({
    type: 'assistant',
    ...(opts.pad === undefined ? {} : { pad: 'x'.repeat(opts.pad) }),
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

async function collect(sweep: SessionSweep): Promise<PricedTurn[]> {
  const out: PricedTurn[] = [];
  for await (const turn of sweep.drain()) out.push(turn);
  return out;
}

function sweepOf(dir: string | null, opts?: { since?: number; chunkBytes?: number }): SessionSweep {
  return openSessionSweep(dir, { chunkBytes: opts?.chunkBytes ?? CHUNK, ...(opts?.since === undefined ? {} : { since: opts.since }) });
}

async function drain(dir: string | null, opts?: { since?: number; chunkBytes?: number }): Promise<PricedTurn[]> {
  return collect(sweepOf(dir, opts));
}

/** Event-loop iterations elapsed, counted by a self-rescheduling check-phase callback — ordering only, with
 *  no wall clock: `setImmediate` fires once per iteration, where a zero timer is clamped to a millisecond and
 *  would report nothing for a sweep that yields many times inside one. */
function eventLoopTicker(): { ticks: () => number; stop: () => void } {
  let ticks = 0;
  let running = true;
  const pump = (): void => {
    if (!running) return;
    ticks += 1;
    setImmediate(pump);
  };
  setImmediate(pump);
  return { ticks: () => ticks, stop: () => { running = false; } };
}

describe('the §27 per-turn session-log sweep', () => {
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
        id: billed('a'),
        model: 'claude-sonnet-5',
        input: 100,
        cacheCreate: 0,
        cacheRead: 0,
        output: 20,
      },
      {
        at: Date.parse('2026-07-09T12:00:02.000Z'),
        id: billed('b'),
        model: 'claude-opus-4-8',
        input: 5,
        cacheCreate: 0,
        cacheRead: 0,
        output: 0,
      },
    ]);
  });

  // The billing identity joins two strings a JSON log may legally carry a NUL inside, so an in-band
  // separator lets ("a\0b", "c") and ("a", "b\0c") resolve to ONE identity — and the second turn's dollars
  // are then dropped from the run's total as a duplicate.
  it('gives two ill-formed identity halves two identities, never one collided key', async () => {
    writeFileSync(
      join(dir, 'session.jsonl'),
      [
        turnLine({ ts: '2026-07-09T12:00:01.000Z', msgId: 'a\u0000b', reqId: 'c', input: 10 }),
        turnLine({ ts: '2026-07-09T12:00:02.000Z', msgId: 'a', reqId: 'b\u0000c', input: 20 }),
      ].join('\n'),
    );
    const turns = await drain(dir);
    expect(turns.map((t) => t.input)).toEqual([10, 20]);
    expect(new Set(turns.map((t) => t.id)).size).toBe(2);
  });

  it('gives a turn carrying no billing identity an identity stable across drains of its log', async () => {
    const log = join(dir, 'session.jsonl');
    writeFileSync(
      log,
      [
        `${turnLine({ ts: '2026-07-09T12:00:01.000Z', input: 10 })}`,
        `${turnLine({ ts: '2026-07-09T12:00:02.000Z', input: 20 })}`,
      ].join('\n'),
    );
    const sweep = sweepOf(dir);
    const first = await collect(sweep);
    expect(first.map((t) => t.input)).toEqual([10, 20]);
    expect(new Set(first.map((t) => t.id)).size).toBe(2);

    appendFileSync(log, `\n${turnLine({ ts: '2026-07-09T12:00:03.000Z', input: 30 })}`);
    const second = await collect(sweep);
    expect(second.map((t) => t.input)).toEqual([10, 20, 30]);
    expect(second.slice(0, 2).map((t) => t.id)).toEqual(first.map((t) => t.id));
  });

  it('yields the nested reviewer-subagent logs, not only the main session', async () => {
    writeFileSync(join(dir, 'main.jsonl'), turnLine({ ts: '2026-07-09T12:00:01.000Z', id: 'w', input: 10 }));
    const subagents = join(dir, 'session-uuid', 'subagents');
    mkdirSync(subagents, { recursive: true });
    writeFileSync(join(subagents, 'agent-x.jsonl'), turnLine({ ts: '2026-07-09T12:00:02.000Z', id: 'r', output: 40 }));
    const turns = await drain(dir);
    expect(turns.map((t) => t.id).sort()).toEqual([billed('r'), billed('w')].sort());
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

  // The §27 sweep places every turn by its own instant, so a turn with no usable one belongs to no
  // interval in the run's window. The aggregate entry point drops such a turn only when a lower bound is
  // given; the sweep excludes it in BOTH directions, so the no-floor branch cannot admit an unplaceable
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

  // CLAUDE.md § dirEntries — absent yields nothing, unreadable THROWS. Conflating them prices an
  // enumerable-but-unreadable log root at a confident $0.00 and persists that into the run's §25 record.
  it('throws rather than reporting nothing when the log root exists but cannot be enumerated', async () => {
    const notADir = join(dir, 'regular-file');
    writeFileSync(notADir, 'this is not a directory');
    await expect(drain(notADir)).rejects.toThrow();
  });

  it.skipIf(process.getuid?.() === 0)('throws when a nested subagent directory refuses enumeration', async () => {
    writeFileSync(join(dir, 'main.jsonl'), turnLine({ ts: '2026-07-09T12:00:01.000Z', id: 'w', input: 10 }));
    const locked = join(dir, 'session-uuid');
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o000);
    try {
      await expect(drain(dir)).rejects.toThrow();
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  // AC 7 — "delays" is bound by ordering. (a) the per-directory half: the sweep relinquishes the event loop
  // BETWEEN logs AND while enumerating them, so work scheduled while a sample is in flight runs before the
  // sample settles. The baseline is taken before the drain begins, so a synchronous walk-then-read cannot
  // pass by having already finished the enumeration when the first turn arrives.
  it('relinquishes the event loop while enumerating, not only between logs', async () => {
    for (const name of ['a.jsonl', 'b.jsonl', 'c.jsonl', 'd.jsonl']) {
      writeFileSync(join(dir, name), turnLine({ ts: '2026-07-09T12:00:01.000Z', id: name, input: 1 }));
    }
    const ticker = eventLoopTicker();
    const baseline = ticker.ticks();
    const marks: number[] = [];
    for await (const _turn of sweepOf(dir, { chunkBytes: 1_000_000 }).drain()) marks.push(ticker.ticks());
    ticker.stop();
    expect(marks.length).toBe(4);
    expect(marks[0]).toBeGreaterThan(baseline);
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
    for await (const _turn of sweepOf(dir, { chunkBytes: 256 }).drain()) marks.push(ticker.ticks());
    ticker.stop();
    expect(marks.length).toBe(200);
    expect(marks[marks.length - 1]).toBeGreaterThan(marks[0]);
  });

  it('reads a turn split across a chunk boundary exactly once', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 40; i += 1) lines.push(turnLine({ ts: '2026-07-09T12:00:01.000Z', id: `s${i}`, input: 1 }));
    writeFileSync(join(dir, 'split.jsonl'), lines.join('\n'));
    const ids = (await drain(dir, { chunkBytes: 37 })).map((t) => t.id);
    expect(ids).toHaveLength(40);
    expect(new Set(ids).size).toBe(40);
  });

  // A chunk boundary is a BYTE boundary, so it can fall inside a multi-byte character. Decoding each chunk
  // as a self-contained document replaces both halves with U+FFFD before the carry can rejoin the line.
  it('reads a turn whose line carries a multi-byte character across the chunk boundary', async () => {
    const model = 'claude-§-5';
    const line = turnLine({ ts: '2026-07-09T12:00:01.000Z', id: 'wide', model, input: 7 });
    writeFileSync(join(dir, 'wide.jsonl'), line);
    const boundary = Buffer.from(line.slice(0, line.indexOf('§')), 'utf8').length + 1;
    const turns = await drain(dir, { chunkBytes: boundary });
    expect(turns.map((t) => t.model)).toEqual([model]);
    expect(turns.map((t) => t.input)).toEqual([7]);
  });

  // The identity a run banks a turn under comes out of Claude Code's private format at whatever length
  // that format hands over, so it is bounded before it becomes a key held for the life of the run
  // (CWE-770). Bounding it by DIGEST rather than by rejection keeps both properties the key needs: the
  // same turn replayed into a resumed session still banks once, and two turns the format identified
  // differently stay apart however long those identities were.
  it('bounds an over-long billing identity without collapsing the turns it identified', async () => {
    const huge = 'x'.repeat(5_000);
    const replay = turnLine({ ts: '2026-07-09T12:00:01.000Z', msgId: huge, reqId: huge, input: 1 });
    writeFileSync(
      join(dir, 'session.jsonl'),
      [replay, turnLine({ ts: '2026-07-09T12:00:03.000Z', id: 'ok', input: 3 })].join('\n'),
    );
    writeFileSync(join(dir, 'resumed.jsonl'), replay);
    const turns = await drain(dir);
    expect(turns.map((t) => t.input).sort()).toEqual([1, 1, 3]);
    for (const t of turns) expect(t.id.length).toBeLessThan(huge.length);
    expect(new Set(turns.map((t) => t.id)).size).toBe(2);
  });

  // Two turns the log identified DIFFERENTLY, alike in every other field: the same instant, model and
  // counts. Rejecting the over-long identity and re-deriving one from the turn's content gives them one
  // key, so the run banks the first and silently drops the second's dollars — the exact collapse the
  // bound exists to prevent, arrived at from the other side (CWE-20, CWE-694).
  it('keeps two turns apart whose over-long identities differ but whose content is identical', async () => {
    const a = 'a'.repeat(5_000);
    const b = 'b'.repeat(5_000);
    writeFileSync(
      join(dir, 'session.jsonl'),
      [
        turnLine({ ts: '2026-07-09T12:00:01.000Z', msgId: a, reqId: a, input: 1000 }),
        turnLine({ ts: '2026-07-09T12:00:01.000Z', msgId: b, reqId: b, input: 1000 }),
      ].join('\n'),
    );
    const turns = await drain(dir);
    expect(turns.map((t) => t.input)).toEqual([1000, 1000]);
    expect(new Set(turns.map((t) => t.id)).size).toBe(2);
  });

  // The boundary the bound is applied at is the COMPOSITE of both halves, not either field: two halves
  // each well under the cap compose past it. At the cap the identity is banked as the log stamped it.
  it('banks an identity exactly at the cap as the log stamped it, and the next character over as a digest', async () => {
    const stamped = async (msgId: string, reqId: string): Promise<PricedTurn> => {
      writeFileSync(join(dir, 'session.jsonl'), turnLine({ ts: '2026-07-09T12:00:01.000Z', msgId, reqId, input: 1 }));
      return (await drain(dir))[0];
    };
    const msgId = 'y'.repeat(MAX_IDENTITY_CHARS / 2);
    const reqId = 'z'.repeat(MAX_IDENTITY_CHARS - JSON.stringify([msgId, '']).length);
    expect(JSON.stringify([msgId, reqId])).toHaveLength(MAX_IDENTITY_CHARS);

    const kept = await stamped(msgId, reqId);
    expect(kept.id).toBe(JSON.stringify([msgId, reqId]));

    const over = await stamped(msgId, `${reqId}z`);
    expect(over.id).not.toBe(JSON.stringify([msgId, `${reqId}z`]));
    expect(over.id.length).toBeLessThan(MAX_IDENTITY_CHARS);
  });

  // AC 3 — the replay a billing identity exists to collapse lands in a DIFFERENT file, so an identity
  // derived from where the turn SITS collapses nothing: the same turn banks once per file it is replayed
  // into and the run's dollars rise by one full copy per resume.
  it('gives a turn carrying no billing identity one identity across the files it is replayed into', async () => {
    const line = turnLine({ ts: '2026-07-09T12:00:01.000Z', input: 7 });
    writeFileSync(join(dir, 'session.jsonl'), line);
    writeFileSync(join(dir, 'resumed.jsonl'), line);
    const turns = await drain(dir);
    expect(turns.map((t) => t.input)).toEqual([7, 7]);
    expect(new Set(turns.map((t) => t.id)).size).toBe(1);
  });

  it('keeps two DIFFERENT turns carrying no billing identity apart', async () => {
    writeFileSync(
      join(dir, 'session.jsonl'),
      [
        turnLine({ ts: '2026-07-09T12:00:01.000Z', input: 7 }),
        turnLine({ ts: '2026-07-09T12:00:02.000Z', input: 7 }),
        turnLine({ ts: '2026-07-09T12:00:02.000Z', input: 9 }),
      ].join('\n'),
    );
    expect(new Set((await drain(dir)).map((t) => t.id)).size).toBe(3);
  });

  // Two identical billed turns are ordinary — the same prompt retried, two subagents handed the same
  // slice — and with no identity stamped nothing in their content tells them apart. An identity that is
  // a pure function of content gives them one key and the run reports half the tokens it was billed for.
  // A replay of the same log still collapses, because the replayed copies arrive in the same order.
  it('keeps two identical turns carrying no billing identity apart, and still collapses their replay', async () => {
    const line = turnLine({ ts: '2026-07-09T12:00:01.000Z', input: 1000 });
    writeFileSync(join(dir, 'session.jsonl'), [line, line].join('\n'));
    const first = await drain(dir);
    expect(first.map((t) => t.input)).toEqual([1000, 1000]);
    expect(new Set(first.map((t) => t.id)).size).toBe(2);

    writeFileSync(join(dir, 'resumed.jsonl'), [line, line, turnLine({ ts: '2026-07-09T12:00:02.000Z', input: 5 })].join('\n'));
    const both = await drain(dir);
    expect(new Set(both.map((t) => t.id)).size).toBe(3);
  });

  // §27 admission, not §26 decode: the model id reaches an in-memory accumulator key, the strip and the
  // append-only §25 record, all from Claude Code's private format (CWE-117/CWE-770).
  it('bounds the model id it hands on, whatever the log stamps', async () => {
    const long = `claude-${'x'.repeat(500)}`;
    writeFileSync(join(dir, 'session.jsonl'), turnLine({ ts: '2026-07-09T12:00:01.000Z', id: 'wide', model: long, input: 1 }));
    const turns = await drain(dir);
    expect(turns[0].model.length).toBeLessThan(long.length);
    expect(long.startsWith(turns[0].model)).toBe(true);
  });

  // A log line has no length limit in the format, and the sweep holds an incomplete line across chunk
  // boundaries — so `chunkBytes` bounds the READ but not the allocation, and one newline-free log is
  // materialised whole on the process that also drains the PTY. `APP_SESSION_LOG_CHUNK_BYTES` reaches
  // 16 MiB, sixteen times the line cap, so an over-long line also arrives as a COMPLETE split element.
  it.each([64 * 1024, 4_000_000])(
    'drops a line longer than the cap instead of materialising it, and keeps reading past it (chunkBytes %d)',
    async (chunkBytes) => {
      writeFileSync(
        join(dir, 'session.jsonl'),
        [
          turnLine({ ts: '2026-07-09T12:00:01.000Z', id: 'huge', input: 5, pad: 2_000_000 }),
          turnLine({ ts: '2026-07-09T12:00:02.000Z', id: 'after', input: 4 }),
        ].join('\n'),
      );
      const turns = await drain(dir, { chunkBytes });
      expect(turns.map((t) => t.id)).toEqual([billed('after')]);
    },
  );

  // `sample()` breaks out of the drain on every retirement or floor change mid-drain, so the log the sweep
  // was reading is abandoned at a `yield`. Without an explicit return the inner generator stays suspended
  // and its FileHandle survives until GC (CWE-772).
  it('closes the log it was reading when the caller abandons the drain', async () => {
    for (let i = 0; i < 8; i += 1) {
      writeFileSync(join(dir, `s${i}.jsonl`), turnLine({ ts: '2026-07-09T12:00:01.000Z', id: `t${i}`, input: 1 }));
    }
    const openFds = (): number => readdirSync('/dev/fd').length;
    const abandon = async (sweep: SessionSweep): Promise<void> => {
      const iter = sweep.drain()[Symbol.asyncIterator]();
      await iter.next();
      await iter.return?.(undefined);
    };
    await abandon(sweepOf(dir));
    const baseline = openFds();
    for (let i = 0; i < 40; i += 1) await abandon(sweepOf(dir));
    expect(openFds()).toBeLessThanOrEqual(baseline);
  });

  it('yields nothing and completes when a log holds one over-long line and nothing else', async () => {
    writeFileSync(join(dir, 'session.jsonl'), turnLine({ ts: '2026-07-09T12:00:01.000Z', id: 'huge', input: 5, pad: 2_000_000 }));
    expect(await drain(dir)).toEqual([]);
  });

  // `usage` is four numbers out of a private format, and the sweep is what puts them on a repeating timer
  // into the strip and the append-only §25 record. A negative one drives the run's total below zero; a
  // pair that cancels hides an unpriced model from the `+unknown` marker; two enormous ones price to NaN,
  // falsifying pricing.ts's own stated invariant that `usd` is always finite.
  it('admits no negative or unbounded usage value, so every sink is handed a priceable number', async () => {
    writeFileSync(
      join(dir, 'session.jsonl'),
      [
        turnLine({ ts: '2026-07-09T12:00:01.000Z', id: 'neg', input: -1_000_000 }),
        turnLine({ ts: '2026-07-09T12:00:02.000Z', id: 'huge', input: 1e308, output: 1e308 }),
        turnLine({ ts: '2026-07-09T12:00:03.000Z', id: 'wide', model: 'claude-opus-4-8', input: 1e308 }),
      ].join('\n'),
    );
    const turns = await drain(dir);
    for (const t of turns) {
      for (const n of [t.input, t.cacheCreate, t.cacheRead, t.output]) {
        expect(Number.isFinite(n)).toBe(true);
        expect(n).toBeGreaterThanOrEqual(0);
      }
    }
    const usd = priceTokens(
      turns.map((t) => ({ model: t.model, input: t.input, cacheCreate: t.cacheCreate, cacheRead: t.cacheRead, output: t.output })),
    ).usd;
    expect(Number.isFinite(usd)).toBe(true);
    expect(usd).toBeGreaterThanOrEqual(0);
  });

  // A chunk size the process cannot allocate is none of the three drifts this module commits to degrading
  // on (absent root, unreadable file, unparseable line). Swallowed alongside them it prices every log at
  // nothing, and the run's §25 record gains a confident $0.00 — the landing §27.11 rejects.
  it('surfaces a chunk size it cannot allocate rather than pricing every log at nothing', async () => {
    writeFileSync(join(dir, 'session.jsonl'), turnLine({ ts: '2026-07-09T12:00:01.000Z', id: 'real', input: 9 }));
    await expect(drain(dir, { chunkBytes: bufferConstants.MAX_LENGTH + 1 })).rejects.toThrow();
  });

  // A subdirectory the app cannot enumerate — a `<session-uuid>/subagents/` left root-owned by a Claude
  // Code run under sudo — aborts the walk. The sweep raises rather than pricing the tree at $0.00, and the
  // turns it had already read are the caller's: they are the run's dollars, already banked.
  it.skipIf(process.getuid?.() === 0)('hands back the turns it read before an unreadable directory aborts the walk', async () => {
    writeFileSync(join(dir, 'a.jsonl'), turnLine({ ts: '2026-07-09T12:00:01.000Z', id: 'a', input: 1 }));
    const locked = join(dir, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    const seen: PricedTurn[] = [];
    try {
      await expect(
        (async () => {
          for await (const turn of sweepOf(dir).drain()) seen.push(turn);
        })(),
      ).rejects.toThrow();
    } finally {
      chmodSync(locked, 0o755);
    }
    expect(seen.map((t) => t.id)).toEqual([billed('a')]);
  });

  // The stale file is planted READABLE and carrying in-window turns: an unreadable one is contractually
  // skipped anyway (AC 7), so it could not tell a skipped file from an opened one.
  it('skips a log whose last write predates the floor, and opens it when there is no floor', async () => {
    const stale = join(dir, 'stale.jsonl');
    writeFileSync(stale, turnLine({ ts: '2026-07-09T12:00:05.000Z', id: 'hidden', input: 999 }));
    const before = (FLOOR - 60_000) / 1000;
    utimesSync(stale, before, before);
    writeFileSync(join(dir, 'live.jsonl'), turnLine({ ts: '2026-07-09T12:00:06.000Z', id: 'live', input: 3 }));

    expect((await drain(dir, { since: FLOOR })).map((t) => t.id)).toEqual([billed('live')]);
    expect((await drain(dir)).map((t) => t.id).sort()).toEqual([billed('hidden'), billed('live')].sort());
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

  it('yields nothing on a second drain when no log changed', async () => {
    writeFileSync(join(dir, 'a.jsonl'), turnLine({ ts: '2026-07-09T12:00:01.000Z', id: 'a', input: 1 }));
    writeFileSync(join(dir, 'b.jsonl'), turnLine({ ts: '2026-07-09T12:00:02.000Z', id: 'b', input: 2 }));
    const sweep = sweepOf(dir);
    expect((await collect(sweep)).map((t) => t.id).sort()).toEqual([billed('a'), billed('b')].sort());
    expect(await collect(sweep)).toEqual([]);
  });

  it('re-reads only the log that grew, and yields its new turn', async () => {
    const grown = join(dir, 'grows.jsonl');
    writeFileSync(join(dir, 'still.jsonl'), turnLine({ ts: '2026-07-09T12:00:01.000Z', id: 'still', input: 1 }));
    writeFileSync(grown, turnLine({ ts: '2026-07-09T12:00:02.000Z', id: 'one', input: 2 }));
    const sweep = sweepOf(dir);
    expect(await collect(sweep)).toHaveLength(2);

    appendFileSync(grown, `\n${turnLine({ ts: '2026-07-09T12:00:03.000Z', id: 'two', input: 3 })}`);
    const second = await collect(sweep);
    expect(second.map((t) => t.id)).toEqual([billed('one'), billed('two')]);
  });

  it('picks up a log created after the first drain', async () => {
    writeFileSync(join(dir, 'a.jsonl'), turnLine({ ts: '2026-07-09T12:00:01.000Z', id: 'a', input: 1 }));
    const sweep = sweepOf(dir);
    expect(await collect(sweep)).toHaveLength(1);

    writeFileSync(join(dir, 'b.jsonl'), turnLine({ ts: '2026-07-09T12:00:02.000Z', id: 'b', input: 2 }));
    expect((await collect(sweep)).map((t) => t.id)).toEqual([billed('b')]);
  });

  // A read that failed is not a read. The memo records the pre-read stamp, and a log that is never written
  // again keeps that mtime and size forever — so remembering a file the sweep could not open turns one
  // transient EACCES/EMFILE into a permanent, silent undercount for the rest of the run. The logs this
  // strands are exactly the ones AC 1 is about: a reviewer subagent's log is closed the moment it exits.
  it.skipIf(process.getuid?.() === 0)('re-reads a log it could not open rather than remembering the read that failed', async () => {
    const locked = join(dir, 'locked.jsonl');
    writeFileSync(join(dir, 'ok.jsonl'), turnLine({ ts: '2026-07-09T12:00:01.000Z', id: 'ok', input: 1 }));
    writeFileSync(locked, turnLine({ ts: '2026-07-09T12:00:02.000Z', id: 'locked', input: 2 }));
    const sweep = sweepOf(dir);
    chmodSync(locked, 0o000);
    try {
      expect((await collect(sweep)).map((t) => t.id)).toEqual([billed('ok')]);
    } finally {
      chmodSync(locked, 0o644);
    }
    expect((await collect(sweep)).map((t) => t.id)).toEqual([billed('locked')]);
  });

  // The other arm: the open succeeded and the READ failed, so the generator returns having yielded only
  // what it got. A symlink to a directory opens and then fails at the first read — the same shape as an
  // EIO or an fd the OS pulls out from under a mid-flight read.
  it('degrades on a log that opens and then refuses to be read, without stranding the rest of the sweep', async () => {
    writeFileSync(join(dir, 'real.jsonl'), turnLine({ ts: '2026-07-09T12:00:01.000Z', id: 'real', input: 1 }));
    mkdirSync(join(dir, 'a-directory'));
    symlinkSync(join(dir, 'a-directory'), join(dir, 'unreadable.jsonl'));
    const sweep = sweepOf(dir);
    expect((await collect(sweep)).map((t) => t.id)).toEqual([billed('real')]);
    expect(await collect(sweep)).toEqual([]);
  });

  // The subtler half of the same arm: a failed OPEN yields nothing, but a failed mid-READ yields PART of a
  // log — and remembering that partial read strands the remainder for the life of the run. Both arms yield
  // nothing on the drain that fails, so the memo is only observable on a LATER drain of the same path: the
  // fixture swaps the unreadable target for a real log stamped to the byte with the memo the sweep would
  // have taken, so a remembered file is skipped and a forgotten one is read.
  it('re-reads a log whose mid-read failure left it half-read, rather than remembering the read that failed', async () => {
    writeFileSync(join(dir, 'real.jsonl'), turnLine({ ts: '2026-07-09T12:00:01.000Z', id: 'real', input: 1 }));
    const target = join(dir, 'a-directory');
    const link = join(dir, 'unreadable.jsonl');
    mkdirSync(target);
    const late = `${turnLine({ ts: '2026-07-09T12:00:02.000Z', id: 'late', input: 2 })}\n`;
    for (let i = 0; statSync(target).size < late.length && i < 4_000; i += 1) {
      writeFileSync(join(target, `pad-${i}.txt`), '');
    }
    expect(statSync(target).size).toBeGreaterThanOrEqual(late.length);
    const stampSec = 1_785_000_000;
    utimesSync(target, stampSec, stampSec);
    symlinkSync(target, link);

    const sweep = sweepOf(dir);
    expect((await collect(sweep)).map((t) => t.id)).toEqual([billed('real')]);

    const stamp = statSync(target);
    const payload = join(dir, 'payload.log');
    writeFileSync(payload, late);
    truncateSync(payload, stamp.size);
    utimesSync(payload, stampSec, stampSec);
    rmSync(link);
    symlinkSync(payload, link);
    expect(statSync(link).size).toBe(stamp.size);
    expect(statSync(link).mtimeMs).toBe(stamp.mtimeMs);

    expect((await collect(sweep)).map((t) => t.id)).toEqual([billed('late')]);
  });

  // A log truncated or replaced under the sweep is not an append: the recorded size goes backwards, so the
  // memory of it is worthless and the file is read from the top again.
  it('re-reads a log that was rewritten smaller rather than trusting its memory of it', async () => {
    const log = join(dir, 'rotated.jsonl');
    writeFileSync(
      log,
      [
        turnLine({ ts: '2026-07-09T12:00:01.000Z', id: 'one', input: 1 }),
        turnLine({ ts: '2026-07-09T12:00:02.000Z', id: 'two', input: 2 }),
      ].join('\n'),
    );
    const sweep = sweepOf(dir);
    expect(await collect(sweep)).toHaveLength(2);

    writeFileSync(log, turnLine({ ts: '2026-07-09T12:00:03.000Z', id: 'fresh', input: 3 }));
    expect((await collect(sweep)).map((t) => t.id)).toEqual([billed('fresh')]);
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

  // AC 10 — every §27 admission rule sits on the §27 yield site, so the decoder both engines share is
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
});
