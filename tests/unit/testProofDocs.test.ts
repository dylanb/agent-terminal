import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TEST_PROOF_CHECKS } from '../../src/main/testProof';

// The operator copies these names into ruleset `main` by hand, and a ruleset matches a status context by
// exact name: a doc name the command never publishes makes every PR unmergeable, and one it omits leaves
// that suite ungated.

const doc = path.join(__dirname, '../../docs/test-proof.md');

function requiredChecks(markdown: string): string[] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => /^#+\s+Required checks\s*$/i.test(l));
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && /^#+\s/.test(l));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .map((l) => /^[-*]\s+(.*)$/.exec(l)?.[1])
    .filter((item): item is string => item !== undefined)
    .map((item) => /`([^`]+)`/.exec(item)?.[1] ?? item.trim())
    .sort();
}

describe('docs/test-proof.md names exactly the proof checks the command publishes', () => {
  it('the doc’s required checks are exactly the names in the proof-check definition', () => {
    const markdown = existsSync(doc) ? readFileSync(doc, 'utf8') : '';
    expect(requiredChecks(markdown)).toEqual(Object.values(TEST_PROOF_CHECKS).sort());
  });

  it('the proof-check definition holds exactly the two published contexts', () => {
    expect(Object.values(TEST_PROOF_CHECKS).sort()).toEqual(['test-proof/e2e', 'test-proof/vitest']);
  });
});
