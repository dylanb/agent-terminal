import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEpicPlan } from '../../src/main/epicPlan';

// §26.9 — the work-agent classifies a plan an epic by writing a `classification: epic` field into
// `.agent-loop/plan.md` (with the sub-ticket breakdown). The signal is data in plan.md, not a state
// status. `readEpicPlan` recovers it from a leading YAML frontmatter block, degrading to "not an epic"
// whenever the marker/breakdown is absent or malformed (never throws — plan.md is LLM-written).
describe('epic plan classification (§26.9)', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'epicplan-'));
    mkdirSync(join(repo, '.agent-loop'), { recursive: true });
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const writePlan = (body: string): void => writeFileSync(join(repo, '.agent-loop', 'plan.md'), body);

  it('reads classification: epic + the sub_tickets breakdown from the frontmatter', () => {
    writePlan(
      [
        '---',
        'classification: epic',
        'sub_tickets:',
        '  - title: First slice',
        '    body: does the first thing',
        '  - title: Second slice',
        '  - title: Third slice',
        '---',
        '',
        '# Plan',
        '',
        'epic body',
      ].join('\n'),
    );
    expect(readEpicPlan(repo)).toEqual({
      isEpic: true,
      subTickets: [
        { title: 'First slice', body: 'does the first thing' },
        { title: 'Second slice', body: '' },
        { title: 'Third slice', body: '' },
      ],
    });
  });

  it('a plan classified anything but epic is not an epic (no sub-tickets)', () => {
    writePlan('---\nclassification: standard\n---\n\n# Plan\n');
    expect(readEpicPlan(repo)).toEqual({ isEpic: false, subTickets: [] });
  });

  it('a plan with no frontmatter is not an epic', () => {
    writePlan('# Plan\n\njust a normal plan body\n');
    expect(readEpicPlan(repo)).toEqual({ isEpic: false, subTickets: [] });
  });

  it('epic classification but a missing/empty sub_tickets list yields no tickets (still flagged epic)', () => {
    writePlan('---\nclassification: epic\n---\n');
    expect(readEpicPlan(repo)).toEqual({ isEpic: true, subTickets: [] });
  });

  it('drops a malformed sub_ticket entry (no title) but keeps the well-formed ones', () => {
    writePlan(
      ['---', 'classification: epic', 'sub_tickets:', '  - body: orphan body no title', '  - title: Kept', '---'].join('\n'),
    );
    expect(readEpicPlan(repo)).toEqual({ isEpic: true, subTickets: [{ title: 'Kept', body: '' }] });
  });

  it('an absent plan.md is not an epic (never throws)', () => {
    expect(readEpicPlan(repo)).toEqual({ isEpic: false, subTickets: [] });
  });

  it('unparseable frontmatter degrades to not-an-epic', () => {
    writePlan('---\nclassification: epic\n  : : bad yaml : :\n---\n');
    expect(readEpicPlan(repo)).toEqual({ isEpic: false, subTickets: [] });
  });
});
