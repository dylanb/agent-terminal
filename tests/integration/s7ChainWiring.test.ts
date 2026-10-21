import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FEATURE_DEV_ID, resolveExampleLoopsV2Dir } from '../../src/main/exampleAssets';
import { resolveLoopDefV2, type LoopDefV2 } from '../../src/main/loopDefV2';
import { createRealAppGateCommit } from '../../src/main/appGateCommit';
import { LOOP_CAPABILITIES_FILENAME } from '../../src/main/loopCapabilities';
import { PHASE_RESULT_FIELDS } from '../../src/shared/phaseResult';
import { createGitRepoFixture } from '../helpers/gitRepo';

// §28.10 S7 (§28.2)

const REPO_DIR = resolve(__dirname, '..', '..');
const BUNDLE_TREE = resolveExampleLoopsV2Dir({ packaged: false, appPath: REPO_DIR });
const CODE_LOOPS = ['infra-loop', 'red-loop', 'green-loop', 'refactor-loop', 'integration-slice-loop'];

function mustResolve(name: string): LoopDefV2 {
  const r = resolveLoopDefV2(name, { tiers: { operator: null, appBundled: BUNDLE_TREE, retired: null }, repoDir: REPO_DIR, flow: FEATURE_DEV_ID });
  if (!r.ok) throw new Error(`${name} did not resolve: ${r.reason}`);
  return r.def;
}

const commitLabel = (name: string): unknown =>
  mustResolve(name).gate.find((g) => g.option === 'approve')?.sideEffects.find((se) => se.kind === 'commit')?.args.label;

describe.each(CODE_LOOPS)('s7 commit-lands — %s', (name) => {
  it('lands its approve commit label as a real commit', async () => {
    const label = commitLabel(name);
    expect(typeof label, `${name} commit label`).toBe('string');
    const fx = createGitRepoFixture();
    try {
      const repo = fx.makeGitRepo('s7commit');
      fx.writeRepoFile(repo, '.gitignore', '.agent-terminal/\n');
      fx.writeRepoFile(repo, 'seed.txt', 'seed\n');
      fx.commitAll(repo, 'baseline');
      fx.writeRepoFile(repo, 'src/new.ts', 'export const x = 1;\n');
      const before = Number(fx.git(repo, ['rev-list', '--count', 'HEAD']));
      const result = await createRealAppGateCommit(repo)({ label: label as string, dirtyAtPhaseStart: [] });
      expect(result.outcome).toBe('committed');
      expect(Number(fx.git(repo, ['rev-list', '--count', 'HEAD']))).toBe(before + 1);
      expect(fx.git(repo, ['log', '-1', '--format=%s'])).toBe(label);
    } finally {
      fx.cleanup();
    }
  });
});

describe('s7 refactor recipe (§28.6 P6c)', () => {
  it('references the capabilities file and embeds no result-file block', () => {
    const body = readFileSync(mustResolve('refactor-loop').work.recipe, 'utf8');
    expect(body).toContain(LOOP_CAPABILITIES_FILENAME);
    expect(body).not.toContain(`"${PHASE_RESULT_FIELDS.outcome}"`);
  });
});

describe('s7 integration-slice-loop (§28.2)', () => {
  it('references the capabilities file in its recipe', () => {
    expect(readFileSync(mustResolve('integration-slice-loop').work.recipe, 'utf8')).toContain(LOOP_CAPABILITIES_FILENAME);
  });
});
