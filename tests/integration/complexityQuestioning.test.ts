import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUNDLED_LOOPS_ROOT, bundledPath } from '../helpers/bundledLoops';

// §28.8.1 — groom questions acceptance criteria the problem does not need, and plan-bundle names the criteria
// that drive the plan's complexity with simpler alternatives. Both are the operator's call: each loop's work
// recipe writes the list under one heading, its reviewers grade against that heading, and its consolidator
// stops for a human while an item under it is undecided. One heading per loop, pinned in all three places, so
// the writer, the reviewers and the consolidator cannot drift apart.
const read = (rel: string): string => readFileSync(bundledPath(rel), 'utf8');

const QUESTIONED_HEADING = '## Questioned acceptance criteria';
const DRIVERS_HEADING = '## Complexity drivers';
const OPERATOR_DECISION = 'Operator decision (';
const PRECEDENCE = 'takes precedence over `clean` and `another round`';
const PROPOSE_ONLY = 'never apply';

const GROOM_FLOWS = ['feature-dev-v2', 'plan-only'];
const groomFile = (flow: string, rel: string): string =>
  readFileSync(join(BUNDLED_LOOPS_ROOT, flow, 'groom-loop', rel), 'utf8');

for (const flow of GROOM_FLOWS) {
  describe(`${flow} groom questions acceptance criteria the problem does not need`, () => {
    const recipe = (): string => groomFile(flow, 'prompts/work.md');

    it('the work recipe lists each questioned criterion, with why and a simpler alternative, for the operator', () => {
      const body = recipe();
      for (const marker of [QUESTIONED_HEADING, 'why', 'alternative', 'recommendation', OPERATOR_DECISION]) {
        expect(body, marker).toContain(marker);
      }
    });

    it('the work recipe proposes, and never drops or narrows a criterion on its own', () =>
      expect(recipe()).toContain(PROPOSE_ONLY));

    it('the intent reviewer flags an unneeded criterion that is not questioned, and routes it to the operator', () => {
      const charter = groomFile(flow, 'charter/intent.md');
      expect(charter).toContain(QUESTIONED_HEADING);
      expect(charter).toContain('needs a human');
    });

    it('the consolidator stops for a human on any undecided questioned criterion, ahead of every other verdict', () => {
      const body = groomFile(flow, 'prompts/consolidate.md');
      for (const marker of [QUESTIONED_HEADING, OPERATOR_DECISION, PRECEDENCE]) expect(body, marker).toContain(marker);
    });
  });
}

// §28.8.1 — groom settles the MVP with the operator before writing the ticket. Each list the interview fills is
// written by the recipe, graded by the reviewer and gated by the consolidator under one heading.
const MVP_HEADING = '## MVP';
const GAPS_HEADING = '## Gaps raised';
const AMBIGUITIES_HEADING = '## Ambiguities and contradictions raised';

for (const flow of GROOM_FLOWS) {
  describe(`${flow} groom settles the MVP with the operator before writing the ticket`, () => {
    const recipe = (): string => groomFile(flow, 'prompts/work.md');

    it('the work recipe interviews the operator in business language, with no question limit, before writing', () => {
      const body = recipe();
      for (const marker of ['interview the operator', 'plain business language', 'full context', 'no question limit']) {
        expect(body, marker).toContain(marker);
      }
      expect(body.indexOf('interview the operator')).toBeLessThan(body.indexOf('Then write the groomed ticket'));
    });

    it('the work recipe writes the MVP and lists gaps, ambiguities and contradictions for the operator', () => {
      const body = recipe();
      for (const marker of [MVP_HEADING, GAPS_HEADING, AMBIGUITIES_HEADING, OPERATOR_DECISION, PROPOSE_ONLY]) {
        expect(body, marker).toContain(marker);
      }
    });

    it('the intent reviewer grades the MVP and routes an unlisted gap, ambiguity or contradiction to the operator', () => {
      const charter = groomFile(flow, 'charter/intent.md');
      for (const marker of [MVP_HEADING, GAPS_HEADING, AMBIGUITIES_HEADING, 'needs a human']) expect(charter, marker).toContain(marker);
    });

    it('the consolidator stops for a human on any undecided gap, ambiguity or contradiction', () => {
      const body = groomFile(flow, 'prompts/consolidate.md');
      for (const marker of [GAPS_HEADING, AMBIGUITIES_HEADING]) expect(body, marker).toContain(marker);
    });
  });
}

describe('plan-bundle names the criteria driving complexity and suggests alternatives', () => {
  const recipe = (): string => read('plan-bundle-loop/prompts/work.md');

  it('the work recipe lists each complexity driver with alternatives and a recommendation for the operator', () => {
    const body = recipe();
    for (const marker of [DRIVERS_HEADING, 'alternative', 'recommendation', OPERATOR_DECISION]) {
      expect(body, marker).toContain(marker);
    }
  });

  it('the work recipe proposes, and never applies an alternative on its own', () => expect(recipe()).toContain(PROPOSE_ONLY));

  for (const lens of ['principal', 'intent']) {
    it(`the ${lens} reviewer flags a costly criterion missing from the drivers list, and routes it to the operator`, () => {
      const charter = read(`plan-bundle-loop/charter/${lens}.md`);
      expect(charter).toContain(DRIVERS_HEADING);
      expect(charter).toContain('needs a human');
    });
  }

  it('the consolidator stops for a human on any undecided complexity driver, ahead of every other verdict', () => {
    const body = read('plan-bundle-loop/prompts/consolidate.md');
    for (const marker of [DRIVERS_HEADING, OPERATOR_DECISION, PRECEDENCE]) expect(body, marker).toContain(marker);
  });
});
