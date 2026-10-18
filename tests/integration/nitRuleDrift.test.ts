import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { CLEAN_RULE_LINES } from '../../src/shared/consolidatorOutput';
import { BUNDLED_LOOPS_ROOT, bundledConsolidatorRecipes } from '../helpers/bundledLoops';
import { sentenceStates, statesText } from '../helpers/statesText';

// #207 AC 9 — every surface that no unit test pins states the one shared text, so a later edit to one copy fails
// here. The bundle is discovered, never listed; `bundledLoopsDiscovery.test.ts` counts each discovery against the
// files on disk.

describe('every bundled consolidator recipe states the shared clean rule (#207 AC 6)', () => {
  it.each(bundledConsolidatorRecipes().map((r) => [relative(BUNDLED_LOOPS_ROOT, r.path), r.path]))('%s', (_rel, path) => {
    const recipe = readFileSync(path, 'utf8');
    expect.soft(statesText(recipe, CLEAN_RULE_LINES)).toBe(true);
    expect.soft(sentenceStates(recipe, ['fixed something', '`another round`']), 'the old clean definition is still stated').toBe(false);
  });
});
