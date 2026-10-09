import { cpSync, existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  return root;
}
