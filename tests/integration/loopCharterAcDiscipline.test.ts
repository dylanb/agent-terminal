import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveExampleLoopsV2Dir } from '../../src/main/exampleAssets';

// Every loop EXCEPT groom must forbid deferring a ticket acceptance criterion — groom is the one loop allowed
// to change the ticket. These pins hold the rule present across the shipped charters/recipes so it cannot
// silently regress the way the un-strengthened intent charter did (a "declared" deferral once passed review).
const SOURCE = resolveExampleLoopsV2Dir({ packaged: false, appPath: resolve(__dirname, '..', '..') });
const read = (rel: string): string => readFileSync(join(SOURCE, rel), 'utf8');

const AC_MARKER = 'No acceptance criterion may be deferred';
const COMPLETENESS_MARKER = 'every prior slice';
const NO_DEFER_TODO_MARKER = 'already-filed future ticket';
const INTEGRATION_MARKER = 'every acceptance criterion of every slice';

const intent = (loop: string): string => `${loop}/charter/intent.md`;
const worker = (loop: string): string => `${loop}/prompts/work.md`;

// refactor-loop carries no intent lens (a behavior-preserving turn); its worker still carries the ban below.
const AC_INTENT = ['impl-loop', 'green-loop', 'red-loop', 'integration-slice-loop', 'plan-loop', 'plan-bundle-loop'].map(intent);
const AC_WORKERS = ['impl-loop', 'green-loop', 'red-loop', 'refactor-loop', 'integration-slice-loop', 'infra-loop', 'plan-loop', 'plan-bundle-loop'].map(worker);
const COMPLETENESS_INTENT = ['impl-loop', 'green-loop'].map(intent);
const CODE_WORKERS = ['impl-loop', 'green-loop', 'red-loop', 'refactor-loop', 'integration-slice-loop', 'infra-loop'].map(worker);

describe('loop charters forbid deferring a ticket AC (every loop but groom)', () => {
  for (const f of [...AC_INTENT, ...AC_WORKERS]) {
    it(`${f} forbids deferring an acceptance criterion`, () => expect(read(f)).toContain(AC_MARKER));
  }

  for (const f of COMPLETENESS_INTENT) {
    it(`${f} carries the prior-slice completeness gate`, () => expect(read(f)).toContain(COMPLETENESS_MARKER));
  }

  for (const f of CODE_WORKERS) {
    it(`${f} bans in-scope deferral markers, allowing only an already-filed future-ticket reference`, () =>
      expect(read(f)).toContain(NO_DEFER_TODO_MARKER));
  }

  // The integration-slice intent charter byte-copies impl's (the repo's reuse model, pinned by
  // s7ChainWiring), whose completeness gate already means "all prior slices + production wiring" at the
  // integration point; the integration-SPECIFIC "every slice, unless the plan says non-goal" statement lives
  // in the integration worker.
  it('the integration worker requires every slice’s ACs implemented and wired into production', () => {
    expect(read(worker('integration-slice-loop'))).toContain(INTEGRATION_MARKER);
  });

  it('the groom loop is EXEMPT — it may change the ticket, so it carries no AC-deferral ban', () => {
    expect(read(intent('groom-loop'))).not.toContain(AC_MARKER);
    expect(read(worker('groom-loop'))).not.toContain(AC_MARKER);
  });
});
