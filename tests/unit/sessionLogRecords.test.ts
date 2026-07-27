import { describe, expect, it } from 'vitest';
import {
  createRunTotals,
  MAX_BANKED_MODELS,
  MAX_IDENTITY_CHARS,
  MAX_RECENT_IDENTITIES,
  type RunTotals,
} from '../../src/main/sessionLogRecords';
import { priceTokens, type ModelTokens } from '../../src/shared/pricing';

const FLOOR = Date.parse('2026-07-09T12:00:00.000Z');

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
    ...(opts.reqId !== undefined ? { requestId: opts.reqId } : opts.id === undefined ? {} : { requestId: `req-${opts.id}` }),
    message: {
      ...(opts.msgId !== undefined ? { id: opts.msgId } : opts.id === undefined ? {} : { id: `msg-${opts.id}` }),
      model: opts.model ?? 'claude-sonnet-5',
      usage: { input_tokens: opts.input ?? 0, output_tokens: opts.output ?? 0 },
    },
  });

function foldAll(totals: RunTotals, lines: string[]): ModelTokens[] {
  for (const line of lines) totals.fold(line);
  return totals.totals();
}

describe('folding session-log records into a run`s totals', () => {
  it('folds a priced turn`s tokens under its model', () => {
    const totals = foldAll(createRunTotals(), [turnLine({ ts: '2026-07-09T12:00:01.000Z', id: 'a', input: 100, output: 20 })]);
    expect(totals).toEqual([{ model: 'claude-sonnet-5', input: 100, cacheCreate: 0, cacheRead: 0, output: 20 }]);
  });

  it('sums turns of one model and keeps distinct models apart, in a stable order', () => {
    const totals = foldAll(createRunTotals(), [
      turnLine({ ts: '2026-07-09T12:00:01.000Z', id: 'a', input: 1 }),
      turnLine({ ts: '2026-07-09T12:00:02.000Z', id: 'b', input: 2 }),
      turnLine({ ts: '2026-07-09T12:00:03.000Z', id: 'c', model: 'claude-opus-4-8', input: 5 }),
    ]);
    expect(totals.map((t) => [t.model, t.input])).toEqual([
      ['claude-opus-4-8', 5],
      ['claude-sonnet-5', 3],
    ]);
  });

  it('folds nothing from a line that is not a priced assistant turn', () => {
    expect(
      foldAll(createRunTotals(), [
        '',
        '   ',
        'not json {{{',
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
        JSON.stringify({ message: { usage: { input_tokens: 5 } } }),
        JSON.stringify({ message: { model: 'claude-sonnet-5' } }),
      ]),
    ).toEqual([]);
  });

  // AC 2 — the run's window is bounded below by the flow's recorded start, so the readout is THIS run's
  // cost and not the repo's lifetime spend, whose sessions share the same project dir.
  it('folds a turn exactly at the window`s floor and none before it', () => {
    const lines = [
      turnLine({ ts: '2026-07-01T00:00:00.000Z', id: 'old', input: 5000 }),
      turnLine({ ts: '2026-07-09T12:00:00.000Z', id: 'edge', input: 7 }),
    ];
    expect(foldAll(createRunTotals(FLOOR), lines)[0].input).toBe(7);
    expect(foldAll(createRunTotals(), lines)[0].input).toBe(5007);
  });

  // A dollar that can be placed in no interval of the run's window could never be accounted for by the
  // run's parts, so an unplaceable turn is excluded on the unbounded branch too.
  it('folds no turn whose instant is missing or unparseable, bounded or not', () => {
    const lines = [
      turnLine({ ts: 'nonsense', id: 'bad', input: 5000 }),
      turnLine({ id: 'absent', input: 3000 }),
      turnLine({ ts: '2026-07-09T12:00:01.000Z', id: 'ok', input: 7 }),
    ];
    expect(foldAll(createRunTotals(FLOOR), lines)[0].input).toBe(7);
    expect(foldAll(createRunTotals(), lines)[0].input).toBe(7);
  });

  // AC 3 — Claude Code writes one record per content block of an assistant message and repeats that
  // message's whole `usage` on each, so one billed API call arrives as several records; a resumed or
  // forked session replays prior turns verbatim into a second log. Both are one billed turn.
  it('counts one billing identity once however many records carry it', () => {
    const record = turnLine({ ts: '2026-07-09T12:00:01.000Z', id: 'work', input: 1000 });
    const totals = createRunTotals(FLOOR);
    expect(foldAll(totals, [record, record, record])[0].input).toBe(1000);
    expect(foldAll(totals, [record])[0].input).toBe(1000);
  });

  // Two identical billed turns are ordinary — the same prompt retried, two subagents handed the same
  // slice — and the log identifies them apart. An identity derived from content would give them one key
  // and the run would report half the tokens it was billed for.
  it('keeps two turns apart whose identities differ though every other field matches', () => {
    const at = '2026-07-09T12:00:01.000Z';
    expect(
      foldAll(createRunTotals(FLOOR), [turnLine({ ts: at, id: 'one', input: 1000 }), turnLine({ ts: at, id: 'two', input: 1000 })])[0]
        .input,
    ).toBe(2000);
  });

  // The identity joins two strings a JSON log may legally carry a NUL inside, so an in-band separator
  // lets ("a\0b", "c") and ("a", "b\0c") resolve to ONE identity — dropping the second turn's dollars.
  it('gives two ill-formed identity halves two identities, never one collided key', () => {
    expect(
      foldAll(createRunTotals(FLOOR), [
        turnLine({ ts: '2026-07-09T12:00:01.000Z', msgId: 'a\u0000b', reqId: 'c', input: 10 }),
        turnLine({ ts: '2026-07-09T12:00:02.000Z', msgId: 'a', reqId: 'b\u0000c', input: 20 }),
      ])[0].input,
    ).toBe(30);
  });

  // A turn is half-identified when the log stamps only one of the two halves; deduping on the half it has
  // would collapse turns that were billed separately.
  it('keeps two half-identified turns apart rather than deduping on the half they carry', () => {
    expect(
      foldAll(createRunTotals(FLOOR), [
        turnLine({ ts: '2026-07-09T12:00:01.000Z', msgId: 'only', input: 10 }),
        turnLine({ ts: '2026-07-09T12:00:02.000Z', msgId: 'only', input: 20 }),
      ])[0].input,
    ).toBe(30);
  });

  // §27 admission, not §26 decode: the model id reaches an in-memory accumulator key, the strip and the
  // append-only §25 record, all from Claude Code's private format (CWE-117/CWE-770).
  it('bounds the model id it folds under, whatever the log stamps', () => {
    const long = `claude-${'x'.repeat(500)}`;
    const model = foldAll(createRunTotals(FLOOR), [turnLine({ ts: '2026-07-09T12:00:01.000Z', id: 'wide', model: long, input: 1 })])[0]
      .model;
    expect(model.length).toBeLessThan(long.length);
    expect(long.startsWith(model)).toBe(true);
  });

  // `usage` is four numbers out of a private format, and this fold puts them on a repeating timer into the
  // strip and the append-only §25 record. A negative one drives the run's total below zero; two enormous
  // ones price to NaN, falsifying pricing.ts's own stated invariant that `usd` is always finite.
  it('folds no negative or unbounded count, so every sink is handed a priceable number', () => {
    const totals = foldAll(createRunTotals(FLOOR), [
      turnLine({ ts: '2026-07-09T12:00:01.000Z', id: 'neg', input: -1_000_000 }),
      turnLine({ ts: '2026-07-09T12:00:02.000Z', id: 'huge', input: 1e308, output: 1e308 }),
    ]);
    for (const t of totals) {
      for (const n of [t.input, t.cacheCreate, t.cacheRead, t.output]) {
        expect(Number.isFinite(n)).toBe(true);
        expect(n).toBeGreaterThanOrEqual(0);
      }
    }
    const { usd } = priceTokens(totals);
    expect(Number.isFinite(usd)).toBe(true);
    expect(usd).toBeGreaterThanOrEqual(0);
  });

  // The identity comes out of a private format at whatever length that format hands over, so it is bounded
  // before it becomes a retained key (CWE-770). Bounding it by DIGEST rather than by rejection keeps both
  // properties: a replayed turn still collapses, and two turns the format identified differently stay apart
  // however long those identities were.
  it('bounds an over-long identity without collapsing the turns it identified', () => {
    const a = 'a'.repeat(5_000);
    const b = 'b'.repeat(5_000);
    const at = '2026-07-09T12:00:01.000Z';
    const replay = turnLine({ ts: at, msgId: a, reqId: a, input: 1000 });
    expect(foldAll(createRunTotals(FLOOR), [replay, replay, turnLine({ ts: at, msgId: b, reqId: b, input: 1000 })])[0].input).toBe(2000);
  });

  // The bound is applied to the COMPOSITE of both halves, not to either field: two halves each well under
  // the cap compose past it.
  it('collapses a replay whose two identity halves each sit under the cap but compose past it', () => {
    const half = 'y'.repeat(MAX_IDENTITY_CHARS - 20);
    const line = turnLine({ ts: '2026-07-09T12:00:01.000Z', msgId: half, reqId: half, input: 1000 });
    expect(JSON.stringify([half, half]).length).toBeGreaterThan(MAX_IDENTITY_CHARS);
    expect(foldAll(createRunTotals(FLOOR), [line, line])[0].input).toBe(1000);
  });

  // CWE-770 — the retained identities are keyed on Claude Code's private log content, so the set is a
  // fixed-capacity window that EVICTS rather than one that refuses: nothing stops being counted, and the
  // accepted exchange is that a duplicate arriving after the window has moved past it counts again.
  it('keeps counting past the retained-identity window, and forgets the identity that fell out of it', () => {
    const totals = createRunTotals(FLOOR);
    const first = turnLine({ ts: '2026-07-09T12:00:01.000Z', id: 'first', input: 1 });
    totals.fold(first);
    for (let i = 0; i < MAX_RECENT_IDENTITIES; i += 1) {
      totals.fold(turnLine({ ts: '2026-07-09T12:00:02.000Z', id: `t${i}`, input: 1 }));
    }
    expect(totals.totals()[0].input).toBe(MAX_RECENT_IDENTITIES + 1);

    totals.fold(first);
    expect(totals.totals()[0].input).toBe(MAX_RECENT_IDENTITIES + 2);
  });

  it('collapses a repeat that is still inside the retained-identity window', () => {
    const totals = createRunTotals(FLOOR);
    const first = turnLine({ ts: '2026-07-09T12:00:01.000Z', id: 'first', input: 1 });
    totals.fold(first);
    for (let i = 0; i < MAX_RECENT_IDENTITIES - 2; i += 1) {
      totals.fold(turnLine({ ts: '2026-07-09T12:00:02.000Z', id: `t${i}`, input: 1 }));
    }
    const before = totals.totals()[0].input;
    totals.fold(first);
    expect(totals.totals()[0].input).toBe(before);
  });

  // CWE-770 on the other key space: the model id is also private-format content, so the number of distinct
  // ones one run accumulates is bounded — and a turn under a model already counted still counts, or the
  // bound would stop the figure rising at all.
  it('bounds how many distinct models one run accumulates, and keeps counting under those it holds', () => {
    const totals = createRunTotals(FLOOR);
    for (let i = 0; i < MAX_BANKED_MODELS + 50; i += 1) {
      totals.fold(turnLine({ ts: '2026-07-09T12:00:01.000Z', id: `m${i}`, model: `made-up-${i}`, input: 1 }));
    }
    expect(totals.totals()).toHaveLength(MAX_BANKED_MODELS);

    const held = totals.totals()[0].model;
    totals.fold(turnLine({ ts: '2026-07-09T12:00:02.000Z', id: 'late', model: held, input: 100 }));
    expect(totals.totals().find((t) => t.model === held)?.input).toBe(101);
  });
});
