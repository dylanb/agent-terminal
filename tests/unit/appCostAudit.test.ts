import { describe, expect, it } from 'vitest';
import {
  appCostEvent,
  auditCost,
  loopCostEvent,
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

  // A record is appended for each newly-observed distinct model id, carrying every id seen so far, so
  // bounding the element without bounding the array leaves the record's size quadratic in a vocabulary
  // that comes from outside the process (CWE-770).
  it('bounds how many unpriced ids one record can carry, not only how long each is', () => {
    const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `claude-made-up-${i}`);
    const carried = (n: number): string[] =>
      (appCostEvent({ usd: 1, unpricedModels: ids(n) }, TS) as Extract<AuditEvent, { type: 'app.cost' }>).unpriced;
    expect(carried(500).length).toBeLessThan(500);
    expect(carried(1000)).toEqual(carried(500));
    expect(carried(500)[0]).toBe('claude-made-up-0');
    expect(carried(2)).toEqual(['claude-made-up-0', 'claude-made-up-1']);
  });

  // Whoever decides whether restating the run's cost would say anything new has to compare against what the
  // record CARRIES, not against the live figure — a run discovering ids past the bound above would otherwise
  // append records byte-identical to their predecessor forever. That is one definition, not two.
  it('answers what a record carries for a cost, in the shape the record is built from', () => {
    // Hostile ids, not clean ones: on `claude-made-up-0` the strip-and-bound is the identity, so a fixture
    // built from those cannot tell one shared definition from two hand-maintained copies that agree today.
    const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `claude\u200e${i}${'x'.repeat(500)}`);
    const cost = { usd: 1, unpricedModels: ids(500) };
    const event = appCostEvent(cost, TS) as Extract<AuditEvent, { type: 'app.cost' }>;
    expect(auditCost(cost)).toEqual({ usd: event.usd, unpricedModels: event.unpriced });
    expect(auditCost(cost).unpricedModels).toEqual(auditCost({ usd: 1, unpricedModels: ids(1000) }).unpricedModels);
    expect(auditCost(cost).unpricedModels[0]).toBe(boundExternalText(ids(1)[0]));
    expect(auditCost(cost).unpricedModels.every((m) => !m.includes('\u200e') && m.length <= 200)).toBe(true);
  });

  // §26.10's `loop.cost` carries the SAME class of text from the SAME decoder into the SAME append-only
  // file, so it is bounded by the same primitive rather than by a second copy of the rule: two sibling
  // events must not spell one bound two ways (CWE-117 / CWE-770). Authorized against AC 10 by the operator
  // at the iter-10 gate — what the RECORD carries moves; §26's numbers, behaviour and rendering do not.
  it('bounds the §26 per-iteration cost record through the same primitive as the §27 one', () => {
    const hostile = `claude\u200e${'x'.repeat(500)}`;
    const event = loopCostEvent({ usd: 2.5, unpricedModels: [hostile] }, 7, TS);
    expect(event).toEqual({ ts: TS, type: 'loop.cost', iteration: 7, usd: 2.5, unpriced: [boundExternalText(hostile)] });

    const many = Array.from({ length: 500 }, (_, i) => `claude-made-up-${i}`);
    const carried = (loopCostEvent({ usd: 1, unpricedModels: many }, 1, TS) as Extract<AuditEvent, { type: 'loop.cost' }>).unpriced;
    expect(carried).toEqual(auditCost({ usd: 1, unpricedModels: many }).unpricedModels);
  });
});
