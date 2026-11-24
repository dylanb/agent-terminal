import { markRunReviewersLoaded } from './runReviewerSession';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump, load } from 'js-yaml';
import { FEATURE_DEV_ID } from '../../src/main/exampleAssets';
import { listLoopFolders } from '../../src/main/loopFolders';
import { resolveLoopDefV2 } from '../../src/main/loopDefV2';
import { reviewRoster } from '../../src/main/reviewTurn';
import { createRunResolver } from '../../src/main/runResolver';
import { reconcileRunReviewers, flowReviewers } from '../../src/main/runReviewers';
import { SHARED_CONFIG_MARKER } from './fakeClaude';

/** The phase loops a fixture flow binds by name and drives with a round-answering fake agent (§27.5). */
export const ROUND_PHASE_LOOPS = ['infra-loop', 'red-loop', 'green-loop', 'refactor-loop', 'integration-slice-loop'] as const;

/** Rewrite the def in `dir` from a work goal into engine review rounds judged by a consolidator. */
function asReviewRounds(dir: string, loop: string): void {
  const defPath = join(dir, `${loop}.yaml`);
  const def = load(readFileSync(defPath, 'utf8')) as { work: Record<string, unknown>; consolidator?: { recipe: string } };
  delete def.work.goal;
  delete def.work.checkpoint;
  def.consolidator = { recipe: 'prompts/consolidate.md' };
  writeFileSync(defPath, dump(def));
  writeFileSync(join(dir, 'prompts', 'consolidate.md'), 'Consolidate this round\'s reviewer reports into one verdict.\n');
}

// The plan-loop gate the fixture runs: the gate options and approve side effect the e2e assert are this fixture's
// input, not the shipped def's configuration.
const PLAN_LOOP_GATE = [
  { option: 'approve', side_effects: [{ kind: 'gh', action: 'mark-ready' }] },
  { option: 'request-changes' },
  { option: 'redo' },
  { option: 'polish' },
];

function ownPlanLoopGate(dir: string): void {
  const defPath = join(dir, 'plan-loop.yaml');
  const def = load(readFileSync(defPath, 'utf8')) as Record<string, unknown>;
  def.gate = PLAN_LOOP_GATE;
  writeFileSync(defPath, dump(def));
}

/** An operator config whose shared loops-v2/<loop>/ folder holds the bundled defs, so a fixture flow of any
 *  name resolves the real shipped loops (§27.8 fallback). A loop shipped by more than one flow's folder takes
 *  the global-fallback flow's copy. Each of ROUND_PHASE_LOOPS runs as review rounds,
 *  so a test of a goal session overlays the shipped def. */
export function seedSharedExampleConfig(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-term-e2e-example-config-'));
  const bundle = join(process.cwd(), 'example', 'loops-v2');
  const folders = listLoopFolders(bundle).sort((a, b) => Number(b.flow === FEATURE_DEV_ID) - Number(a.flow === FEATURE_DEV_ID));
  for (const { name, dir, flow } of folders) {
    const dest = join(root, 'loops-v2', name);
    if (!existsSync(dest)) cpSync(dir, dest, { recursive: true });
    if (flow !== null) cpSync(dir, join(root, 'loops-v2', flow, name), { recursive: true });
  }
  for (const loop of ROUND_PHASE_LOOPS) asReviewRounds(join(root, 'loops-v2', loop), loop);
  ownPlanLoopGate(join(root, 'loops-v2', 'plan-loop'));
  cpSync(join(process.cwd(), 'example', 'commands'), join(root, 'commands'), { recursive: true });
  writeFileSync(join(root, SHARED_CONFIG_MARKER), root);
  return root;
}

/** Prepares only the fixture flow's reviewers before its agent starts. A caller selecting a flow later
 * supplies that fixture's loop names explicitly; no unrelated generated reviewers are seeded. */
export function installBundledRunReviewers(runFolder: string, configDir: string, globalDir = runFolder, loopNames?: readonly string[]): void {
  const bundle = join(process.cwd(), 'out/main/example/loops-v2');
  const tiers = { operator: join(configDir, 'loops-v2'), appBundled: bundle, retired: null };
  const load = createRunResolver(globalDir, tiers)(runFolder).load;
  if (!load.ok && loopNames === undefined) return;
  const resolve = (name: string) => resolveLoopDefV2(name, { tiers, repoDir: runFolder, ...(load.ok ? { flow: load.definition.name } : {}) });
  const catalog = loopNames === undefined && load.ok
    ? flowReviewers(load.definition.steps, resolve)
    : { reviewers: (loopNames ?? []).flatMap((name) => {
      const result = resolve(name);
      if (!result.ok) throw new Error(result.reason);
      return reviewRoster(result.def).map((reviewer) => ({ ...reviewer, definitionFile: result.definitionFile }));
    }), problems: [] };
  // Deliberately invalid definitions are diagnosed by the app in refusal tests, not by fixture setup.
  if (catalog.problems.length > 0) return;
  const { problems } = reconcileRunReviewers(runFolder, catalog);
  if (problems.length > 0) throw new Error(problems.join('; '));
  markRunReviewersLoaded(runFolder);
}
