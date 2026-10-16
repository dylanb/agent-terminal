import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_REVIEWER_AGENT, planReviewerAgents } from '../../src/main/reviewerAgents';
import { userConfigAgentsDir } from '../../src/main/userConfig';

/** An operator config whose shared loops-v2/<loop>/ folder holds the bundled defs, so a fixture flow of any
 *  name resolves the real shipped loops (§27.8 fallback). The bundle groups defs by flow; a loop shipped by
 *  more than one flow takes feature-dev-v2's copy. */
export function seedSharedExampleConfig(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-term-e2e-example-config-'));
  const bundle = join(process.cwd(), 'example', 'loops-v2');
  const flows = readdirSync(bundle).sort((a, b) => Number(b === 'feature-dev-v2') - Number(a === 'feature-dev-v2'));
  for (const flow of flows) {
    for (const loop of readdirSync(join(bundle, flow))) {
      const dest = join(root, 'loops-v2', loop);
      if (!existsSync(dest)) cpSync(join(bundle, flow, loop), dest, { recursive: true });
    }
  }
  cpSync(join(process.cwd(), 'example', 'commands'), join(root, 'commands'), { recursive: true });
  const agents = userConfigAgentsDir(root);
  if (agents === null) throw new Error(`no agents directory under ${root}`);
  mkdirSync(agents, { recursive: true });
  for (const agent of planReviewerAgents(bundle, CLAUDE_REVIEWER_AGENT)) writeFileSync(join(agents, agent.rel), agent.bytes());
  return root;
}
