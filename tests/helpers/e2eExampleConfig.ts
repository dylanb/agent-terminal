import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump, load } from 'js-yaml';
import { FEATURE_DEV_ID } from '../../src/main/exampleAssets';
import { CLAUDE_REVIEWER_AGENT, planReviewerAgents } from '../../src/main/reviewerAgents';
import { userConfigAgentsDir } from '../../src/main/userConfig';

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

/** An operator config whose shared loops-v2/<loop>/ folder holds the bundled defs, so a fixture flow of any
 *  name resolves the real shipped loops (§27.8 fallback). The bundle groups defs by flow; a loop shipped by
 *  more than one flow takes the global-fallback flow's copy. Each of ROUND_PHASE_LOOPS runs as review rounds,
 *  so a test of a goal session overlays the shipped def. */
export function seedSharedExampleConfig(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-term-e2e-example-config-'));
  const bundle = join(process.cwd(), 'example', 'loops-v2');
  const flows = readdirSync(bundle).sort((a, b) => Number(b === FEATURE_DEV_ID) - Number(a === FEATURE_DEV_ID));
  for (const flow of flows) {
    for (const loop of readdirSync(join(bundle, flow))) {
      const dest = join(root, 'loops-v2', loop);
      if (!existsSync(dest)) cpSync(join(bundle, flow, loop), dest, { recursive: true });
    }
  }
  for (const loop of ROUND_PHASE_LOOPS) asReviewRounds(join(root, 'loops-v2', loop), loop);
  cpSync(join(process.cwd(), 'example', 'commands'), join(root, 'commands'), { recursive: true });
  const agents = userConfigAgentsDir(root);
  if (agents === null) throw new Error(`no agents directory under ${root}`);
  mkdirSync(agents, { recursive: true });
  for (const agent of planReviewerAgents(bundle, CLAUDE_REVIEWER_AGENT)) writeFileSync(join(agents, agent.rel), agent.bytes());
  return root;
}
