import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { bundledPath } from '../helpers/bundledLoops';

// A review round once returned clean on a unit-only run while the repo's e2e suite was red. Every reviewer
// whose lane is test evidence must require that all the test types relevant to the in-scope change were
// actually run, as the repo's own conventions prescribe — never a fixed, repo-specific command.
// Whitespace-collapsed: a markdown hard wrap is not a content change.
const read = (rel: string): string => readFileSync(bundledPath(rel), 'utf8').replace(/\s+/g, ' ');

const RAN_MARKER = 'every test needed to prove the in-scope change has actually been run';
const CONVENTIONS_MARKER = "the repository's own conventions";

const TEST_EVIDENCE_CHARTERS = [
  ...['infra-loop', 'red-loop', 'green-loop', 'refactor-loop', 'integration-slice-loop'].map((l) => `${l}/charter/tests.md`),
  'red-loop/charter/red-authenticity.md',
  'green-loop/charter/regression-guard.md',
];

const REPO_SPECIFIC = ['podman', 'playwright', 'vitest', 'pnpm', 'e2e-podman.sh'];

describe('test-evidence reviewer charters require the relevant tests to have been run', () => {
  for (const f of TEST_EVIDENCE_CHARTERS) {
    it(`${f} requires every relevant test type to have actually been run`, () => {
      expect(read(f)).toContain(RAN_MARKER);
    });

    it(`${f} defers to the repository's conventions for what to run and how`, () => {
      expect(read(f)).toContain(CONVENTIONS_MARKER);
    });

    it(`${f} names no repo-specific test tool`, () => {
      const body = read(f).toLowerCase();
      for (const tool of REPO_SPECIFIC) expect(body, `${f}: mentions ${tool}`).not.toContain(tool);
    });
  }
});
