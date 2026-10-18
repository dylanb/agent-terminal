// #207 — the operator's NIT definition and the definition of documentation: one text each, which the fixer
// criterion, the reviewer hand-off, the spec and the bundled recipes state and the drift tests compare against.

import { FIXED_DISPOSITION } from './roundReport';

/** The operator's text, word for word (§27.6); the ticket forbids editing it. */
export const NIT_DEFINITION_LINES: readonly string[] = [
  'A change is a NIT if it meets ALL of the following criteria:',
  '',
  '1. **Behavioral Equivalence:** It produces identical runtime output, side effects, and control flow across all valid, invalid, and edge-case inputs.',
  '2. **Zero Performance Impact:** It has no material impact on execution speed, memory footprint, I/O, concurrency, or resource consumption.',
  '3. **Zero Future Debt:**',
  '   - It does not prevent future extensibility, refactoring, or API evolution.',
  '   - It does not violate any enforceable project-wide linting, formatting, typing, or CI/CD rules (if CI passes without it, it qualifies).',
  '   - It does not conceal logic in a way that makes bug diagnosis significantly harder.',
  '4. **Preference-Driven:** It is rooted entirely in personal preference, alternative idiomatic phrasing, or subjective aesthetics where the existing implementation is already clear and standard.',
  '',
  '**Classification Test (the "Safe-to-Ignore" Rule).** Evaluate the change against this question: "If this pull request is merged without this change, could any test fail, bug arise, security vulnerability open, system resource degrade, or future contributor be materially misled or blocked?"',
  '',
  '- If the answer is "No" to all: the change is a NIT → Status: OPTIONAL / DO NOT IMPLEMENT.',
  '- If the answer is "Yes" or "Maybe" to any: the change is NOT A NIT.',
];

/** §27.6 */
export const DOCUMENTATION_DEFINITION_LINES: readonly string[] = [
  'A change is documentation when it alters only prose documentation files, such as Markdown, the spec and',
  'READMEs, or comments in code files, leaving every other token of the code unchanged. These are not',
  "documentation: the loop's own flow documents under `.agent-terminal/loop/artifacts/` (the groomed ticket, the",
  'plan, phase results), because in plan and groom loops they are the work under review; configuration, data and',
  'build files; prompt, recipe and charter files an agent executes; and string literals, identifiers or anything',
  `else the program reads at runtime. When unsure, the fix is \`${FIXED_DISPOSITION}\`.`,
];
