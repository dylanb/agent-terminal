import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_LOOP_DIR_SEGMENTS, ARTIFACTS_SUBDIR } from '../../src/main/appLoopPaths';
import { resolveLoopDefV2, type LoopDefV2Result } from '../../src/main/loopDefV2';

const DECIDING_LOOP = `version: v2
name: plan-loop
work:
  recipe: prompts/work.md
  artifact: plan
reviewers: []
boundaries: []
report:
  sections: [summary]
gate:
  - option: approve
    side_effects: []
outputs:
  - id: plan
    path: plan.md
  - id: verdict
    path: verdict.json
decision:
  output: verdict
`;

export interface LinkedDecision {
  link: string;
  target: string;
  targetText: string;
}

/** Plant `verdict.json` in `repoDir`'s artifacts folder as a link to `saved.json` beside it, holding a valid
 *  decision of `value`. */
export function linkDecisionFile(repoDir: string, value: string): LinkedDecision {
  const artifacts = join(repoDir, ...APP_LOOP_DIR_SEGMENTS, ARTIFACTS_SUBDIR);
  mkdirSync(artifacts, { recursive: true });
  const target = join(artifacts, 'saved.json');
  const targetText = JSON.stringify({ decision: value });
  writeFileSync(target, targetText);
  const link = join(artifacts, 'verdict.json');
  symlinkSync('saved.json', link);
  return { link, target, targetText };
}

/** Resolve, through the real resolver, a `plan-loop` definition planted under `tierRoot` whose decision output
 *  is `verdict.json`. */
export function resolveDecidingLoop(tierRoot: string, repoDir: string): LoopDefV2Result {
  const defDir = join(tierRoot, 'plan-loop');
  mkdirSync(join(defDir, 'prompts'), { recursive: true });
  writeFileSync(join(defDir, 'prompts', 'work.md'), 'Produce the plan.\n');
  writeFileSync(join(defDir, 'plan-loop.yaml'), DECIDING_LOOP);
  return resolveLoopDefV2('plan-loop', { tiers: { operator: join(tierRoot, 'no-operator-tier'), appBundled: tierRoot, retired: null }, repoDir });
}
