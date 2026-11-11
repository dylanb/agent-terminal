import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { load as parseYaml } from 'js-yaml';

const BUNDLE_LOOPS = path.resolve('example', 'loops-v2');

describe('the bundled Codex loops', () => {
  it('finds every file a bundled loop definition names', () => {
    for (const flow of readdirSync(BUNDLE_LOOPS)) {
      for (const loop of readdirSync(path.join(BUNDLE_LOOPS, flow))) {
        const dir = path.join(BUNDLE_LOOPS, flow, loop);
        const def = parseYaml(readFileSync(path.join(dir, `${loop}.yaml`), 'utf8')) as {
          work: { recipe: string };
          consolidator?: { recipe: string };
          brief?: string;
          reviewers: { charter: string }[];
        };
        const named = [def.work.recipe, ...(def.consolidator !== undefined ? [def.consolidator.recipe] : []), ...(def.brief !== undefined ? [def.brief] : []), ...def.reviewers.map((r) => r.charter)];
        for (const rel of named) expect(existsSync(path.join(dir, rel)), `${loop}: ${rel}`).toBe(true);
      }
    }
  });
});
