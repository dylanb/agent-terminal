import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump, load } from 'js-yaml';
import { FEATURE_DEV_ID } from '../../src/main/exampleAssets';
import { listLoopFolders } from '../../src/main/loopFolders';
import { resolveLoopDefV2 } from '../../src/main/loopDefV2';
import { reviewRoster } from '../../src/main/reviewTurn';
import { ensureRunReviewers, runAgentsDir } from '../../src/main/runReviewers';

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
  for (const { name, dir } of folders) {
    const dest = join(root, 'loops-v2', name);
    if (!existsSync(dest)) cpSync(dir, dest, { recursive: true });
  }
  for (const loop of ROUND_PHASE_LOOPS) asReviewRounds(join(root, 'loops-v2', loop), loop);
  ownPlanLoopGate(join(root, 'loops-v2', 'plan-loop'));
  cpSync(join(process.cwd(), 'example', 'commands'), join(root, 'commands'), { recursive: true });
  return root;
}

/** Installs every bundled reviewer into a seeded run folder before any agent starts in it, as an earlier run
 *  in that folder would have, so a fake agent launched next counts as having loaded them (§27.4). */
export function installBundledRunReviewers(runFolder: string): void {
  const bundle = join(process.cwd(), 'example', 'loops-v2');
  const reviewers = listLoopFolders(bundle).flatMap((folder) => {
    const r = resolveLoopDefV2(folder.name, { tiers: { operator: null, appBundled: bundle, retired: null }, repoDir: bundle, flow: folder.flow ?? undefined });
    if (!r.ok) throw new Error(r.reason);
    return reviewRoster(r.def);
  });
  const { problems } = ensureRunReviewers(runFolder, reviewers, bundle);
  if (problems.length > 0) throw new Error(problems.join('; '));
  // An earlier run wrote them, well before any agent session the test starts.
  const earlier = new Date(Date.now() - 3_600_000);
  const agents = runAgentsDir(runFolder).dir;
  for (const file of readdirSync(agents)) utimesSync(join(agents, file), earlier, earlier);
}
