import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createEpicPromotionCoordinator, runEpicPromotion } from '../../src/main/epicPromotion';
import { readEpicPromotion, writeEpicPromotion } from '../../src/main/appLoopState';
import { writeActiveFlow } from '../../src/main/activeFlowPointer';
import { readRunBinding, recordDisposition } from '../../src/main/runDisposition';
import { catalogEntryDefFile } from '../../src/main/flow';
import { exampleEpicPlan, parseEpicPlan } from '../../src/shared/epicPlan';
import type { LoopDefV2 } from '../../src/main/loopDefV2';
import type { FlowStateView } from '../../src/shared/ipc';
import { recordingEpicPromotionGh } from '../helpers/recordingEpicPromotionGh';

// #167 AC 2 (§18.7.5) — the flow is bound at each sub-ticket's own Start, so promotion records none on it.
const X = { id: 'epic-x-catalog-id', name: 'Epic X Flow Name' } as const;

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'epic-no-flow-stamp-'));
  const def = catalogEntryDefFile(repo, X.id);
  mkdirSync(dirname(def), { recursive: true });
  writeFileSync(def, `name: ${JSON.stringify(X.name)}\nsteps:\n  - id: plan-bundle\n    kind: manual\n`);
  writeActiveFlow(repo, X.id);
  recordDisposition(repo, { source: 'catalog', tier: 'repo', id: X.id });
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('epic promotion from a run bound to catalog flow X (#167 AC 2)', () => {
  it('creates sub-tickets whose titles, bodies and labels name neither X\'s catalog-entry ID nor its flow name', async () => {
    expect(readRunBinding(repo), 'the run is bound to X').toEqual({ source: 'catalog', tier: 'repo', id: X.id });
    const plan = exampleEpicPlan(2);
    for (const needle of Object.values(X)) expect(plan, `the epic plan never names ${needle}`).not.toContain(needle);
    const parsed = parseEpicPlan(plan);
    if (parsed === null) throw new Error('exampleEpicPlan(2) did not parse as an epic plan');

    const { gh, created } = recordingEpicPromotionGh();
    const coord = createEpicPromotionCoordinator({
      readSubTickets: () => parsed.subTickets,
      promotionRecordBlock: () => null,
      emitPreview: () => {},
      runPromotion: (repoDir, request) =>
        runEpicPromotion(gh, request, {
          read: (epic) => readEpicPromotion(repoDir, epic),
          write: (state) => writeEpicPromotion(repoDir, state),
        }),
      persistAccept: () => {},
      terminateFlow: () => ({ outcome: 'reset', view: {} as FlowStateView }),
      audit: () => {},
      emitError: (_repoDir, reason) => {
        throw new Error(`promotion failed: ${reason}`);
      },
      onViewChanged: () => {},
    });

    expect(coord.maybeBegin(repo, {} as LoopDefV2, 'plan-bundle-loop', 'plan-bundle', 'consolidate-plan-bundle', { epic: 176, pr: 4242 })).toEqual({
      kind: 'preview-raised',
    });
    await coord.resolve(repo, 'plan-bundle', true);

    const tickets = created();
    expect(tickets, 'exactly two sub-tickets were created').toHaveLength(2);
    for (const ticket of tickets) expect(ticket.labels, `sub-ticket #${ticket.issue} was labelled`).not.toEqual([]);
    for (const ticket of tickets) {
      for (const needle of Object.values(X)) {
        expect.soft(ticket.title, `sub-ticket #${ticket.issue}'s title records no ${needle}`).not.toContain(needle);
        expect.soft(ticket.body, `sub-ticket #${ticket.issue}'s body records no ${needle}`).not.toContain(needle);
        for (const label of ticket.labels) expect.soft(label, `sub-ticket #${ticket.issue}'s labels record no ${needle}`).not.toContain(needle);
      }
    }
  });
});
