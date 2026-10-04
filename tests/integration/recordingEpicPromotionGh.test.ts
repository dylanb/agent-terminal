import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEpicPromotion } from '../../src/main/epicPromotion';
import { readEpicPromotion, writeEpicPromotion } from '../../src/main/appLoopState';
import { recordingEpicPromotionGh } from '../helpers/recordingEpicPromotionGh';

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'recording-epic-gh-'));
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('recordingEpicPromotionGh', () => {
  it('records every sub-ticket a real promotion creates, with its title, body and the labels applied to it', async () => {
    const { gh, created } = recordingEpicPromotionGh();
    await runEpicPromotion(
      gh,
      {
        epic: 176,
        pr: 4242,
        subTickets: [
          { index: 1, title: 'Slice one', body: 'Acceptance criteria: a\n\nplan one' },
          { index: 2, title: 'Slice two', body: 'Acceptance criteria: b\n\nplan two' },
        ],
      },
      { read: (epic) => readEpicPromotion(repo, epic), write: (state) => writeEpicPromotion(repo, state) },
    );

    expect(created().map(({ issue, title }) => [issue, title])).toEqual([
      [501, 'Slice one'],
      [502, 'Slice two'],
    ]);
    expect(created()[0].body).toContain('plan one');
    expect(created()[1].body).toContain('plan two');
    for (const ticket of created()) expect(ticket.labels).toContain('agent-loop/subticket');

    await gh.addLabel(502, 'only-two');
    expect(created()[0].labels).not.toContain('only-two');
    expect(created()[1].labels).toContain('only-two');

    await gh.appendIssueBody(501, '\nflow: stamped', 'flow:');
    expect(created()[0].body).toContain('flow: stamped');
    expect(created()[1].body).not.toContain('flow: stamped');
  });
});
