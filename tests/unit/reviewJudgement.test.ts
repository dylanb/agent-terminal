import { describe, expect, it } from 'vitest';
import { DOCUMENTATION_DEFINITION_LINES, NIT_DEFINITION_LINES } from '../../src/shared/reviewJudgement';
import { normaliseText, sentenceStates } from '../helpers/statesText';

// #207 — copied verbatim from the ticket's "The NIT definition" section: the operator's text, which this ticket
// does not edit. Every other surface is compared with the shared constant; this is the one check that the
// constant is the operator's text.
const OPERATOR_NIT_DEFINITION = `
A change is a NIT if it meets ALL of the following criteria:

1. **Behavioral Equivalence:** It produces identical runtime output, side effects, and control flow across all
   valid, invalid, and edge-case inputs.
2. **Zero Performance Impact:** It has no material impact on execution speed, memory footprint, I/O,
   concurrency, or resource consumption.
3. **Zero Future Debt:**
   - It does not prevent future extensibility, refactoring, or API evolution.
   - It does not violate any enforceable project-wide linting, formatting, typing, or CI/CD rules (if CI passes
     without it, it qualifies).
   - It does not conceal logic in a way that makes bug diagnosis significantly harder.
4. **Preference-Driven:** It is rooted entirely in personal preference, alternative idiomatic phrasing, or
   subjective aesthetics where the existing implementation is already clear and standard.

**Classification Test (the "Safe-to-Ignore" Rule).** Evaluate the change against this question: "If this pull
request is merged without this change, could any test fail, bug arise, security vulnerability open, system
resource degrade, or future contributor be materially misled or blocked?"

- If the answer is "No" to all: the change is a NIT → Status: OPTIONAL / DO NOT IMPLEMENT.
- If the answer is "Yes" or "Maybe" to any: the change is NOT A NIT.
`;

describe('the shared NIT definition (#207 AC 3, AC 9)', () => {
  it("is the operator's text, word for word", () => {
    expect(normaliseText(NIT_DEFINITION_LINES.join('\n'))).toBe(normaliseText(OPERATOR_NIT_DEFINITION));
  });
});

describe('the shared definition of documentation (#207 AC 12, scope 14)', () => {
  const definition = DOCUMENTATION_DEFINITION_LINES.join('\n');

  it('counts comments in code files as documentation', () => {
    expect(sentenceStates(definition, ['comments in code files', 'documentation'])).toBe(true);
  });

  it("does not count the loop's flow documents as documentation", () => {
    expect(sentenceStates(definition, ['not documentation', '`.agent-terminal/loop/artifacts/`'])).toBe(true);
  });
});
