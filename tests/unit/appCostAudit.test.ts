import { describe, expect, it } from 'vitest';
import {
  appCostEvent,
  boundExternalText,
  notifyFailedEvent,
  parseAuditStream,
  reconstructTimeline,
  serializeDoc,
  type AuditEvent,
} from '../../src/shared/audit';

const TS = '2026-07-26T12:00:00Z';
const stream = (events: AuditEvent[]): string =>
  serializeDoc({ flow: 'v2-work', repo: 'repo', repoPath: '/repo', started: TS }) + events.map(serializeDoc).join('');

// §27.11/§25 — the §27 run's cost is an ADDITIVE record in the shared audit vocabulary: one definition for
// the main-process writer, the tests and any future viewer, folded into its OWN timeline field so no
// iteration identity is fabricated for a whole-run figure.
describe('the §27 cost record in the shared audit vocabulary', () => {
  it('round-trips through serialize → parse → fold into its own field', () => {
    const text = stream([appCostEvent({ usd: 4.5, unpricedModels: ['claude-made-up-9'] }, TS)]);
    expect(parseAuditStream(text).events).toEqual([
      { ts: TS, type: 'app.cost', usd: 4.5, unpriced: ['claude-made-up-9'] },
    ]);
    const timeline = reconstructTimeline(text);
    expect(timeline.appCost).toEqual({ usd: 4.5, unpriced: ['claude-made-up-9'] });
  });

  // §27.15 — no §26 audit event is recorded for a §27 action, so the per-iteration series stays empty.
  it('leaves the §26 per-iteration cost series empty', () => {
    const timeline = reconstructTimeline(stream([appCostEvent({ usd: 1.25, unpricedModels: [] }, TS)]));
    expect(timeline.costs).toEqual([]);
  });

  // The record is written on each figure-moving sample while the run is open, so the stream carries a
  // series and the field's value is its LAST entry — the most complete figure that existed before the run
  // file closed. A reader that sums the series reports several times the run's dollars.
  it('folds a multi-event stream to the value of its LAST entry, never to a sum', () => {
    const timeline = reconstructTimeline(
      stream([
        appCostEvent({ usd: 1, unpricedModels: [] }, TS),
        appCostEvent({ usd: 3, unpricedModels: [] }, TS),
        appCostEvent({ usd: 4.5, unpricedModels: ['claude-made-up-9'] }, TS),
      ]),
    );
    expect(timeline.appCost).toEqual({ usd: 4.5, unpriced: ['claude-made-up-9'] });
  });

  it('reads no recorded §27 cost from a stream that carries none', () => {
    expect(reconstructTimeline(stream([])).appCost).toBeNull();
  });

  // A model id comes out of Claude Code's private log format — untrusted text reaching a human-facing sink.
  // The strip-and-bound is ONE primitive: two copies agree the day they are written and diverge after.
  it('bounds and strips a model id and a notify reason through the same primitive', () => {
    const hostile = `claude\u200e${'x'.repeat(500)}`;
    const bounded = boundExternalText(hostile);
    const event = appCostEvent({ usd: 0, unpricedModels: [hostile] }, TS);
    expect(event).toEqual({ ts: TS, type: 'app.cost', usd: 0, unpriced: [bounded] });
    expect(notifyFailedEvent(hostile, TS)).toEqual({ ts: TS, type: 'notify.failed', reason: bounded });
    expect(bounded).not.toContain('\u200e');
    expect(bounded.length).toBeLessThan(hostile.length);
  });

  // Each newly-observed distinct model id changes the figure, so it also defeats the has-this-moved memo
  // and appends another record carrying every id seen so far. Bounding the element without bounding the
  // array leaves the record's size quadratic in a vocabulary that comes from outside the process (CWE-770).
  it('bounds how many unpriced ids one record can carry, not only how long each is', () => {
    const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `claude-made-up-${i}`);
    const carried = (n: number): string[] =>
      (appCostEvent({ usd: 1, unpricedModels: ids(n) }, TS) as Extract<AuditEvent, { type: 'app.cost' }>).unpriced;
    expect(carried(500).length).toBeLessThan(500);
    expect(carried(1000)).toEqual(carried(500));
    expect(carried(500)[0]).toBe('claude-made-up-0');
    expect(carried(2)).toEqual(['claude-made-up-0', 'claude-made-up-1']);
  });
});
