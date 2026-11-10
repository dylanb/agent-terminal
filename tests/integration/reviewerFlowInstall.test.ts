import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { load as parseYaml } from 'js-yaml';
import { parse as parseToml } from 'smol-toml';
import { reviewerAgentFor } from '../../src/main/reviewTurn';
import { codexReviewerInstructions } from '../helpers/reviewerContracts';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { applyInstallExamples, exampleInstallDirs } from '../../src/main/installExamples';
import { resolveExampleFlowsDir, resolveExampleLoopsV2Dir } from '../../src/main/exampleAssets';
import { userConfigAgentsDir } from '../../src/main/userConfig';
import { codexAgentsDir } from '../../src/main/codexConfig';
import { writeFlow, writeLoopDef } from '../helpers/flowFixtures';
import { snapshotTree } from '../helpers/treeSnapshot';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(divergent: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-flow-install-'));
  roots.push(root);
  const loc = { packaged: false as const, appPath: join(root, 'bundle') };
  const configDir = join(root, 'claude');
  const codexHome = join(root, 'codex');
  mkdirSync(codexHome);
  for (const [index, name] of ['cedar', 'birch'].entries()) {
    writeFlow(join(resolveExampleFlowsDir(loc), `catalog-${index}`), {
      name, steps: [{ id: 'quality', kind: 'loop', loop: 'quality-loop' }],
    });
    const def = writeLoopDef(resolveExampleLoopsV2Dir(loc), 'quality-loop', {
      charters: ['review.md'], consolidator: 'consolidate.md',
    }, { flow: name });
    writeFileSync(join(dirname(def), 'review.md'), divergent ? `${name} contract\n` : 'Shared contract\n');
  }
  const dirs = exampleInstallDirs(loc, { configDir, codexHome, flowGlobalDir: join(root, 'app') })
    .filter((d) => d.id === 'agents' || d.id === 'codexAgents');
  return { loc, dirs, agents: [userConfigAgentsDir(configDir)!, codexAgentsDir(codexHome)] };
}

describe('Settings reviewer installation preserves independent flow contracts', () => {
  it('installs both differently named flows when their shared persona has different charters', () => {
    const { dirs, agents } = fixture(true);
    const result = applyInstallExamples(dirs, []);
    for (const [index, kind] of (['claude-code', 'codex'] as const).entries()) {
      const actual = result.ok ? readdirSync(agents[index]).map((file) => {
        const text = readFileSync(join(agents[index], file), 'utf8');
        if (kind === 'codex') {
          const doc = parseToml(text);
          return { name: doc.name, instructions: doc.developer_instructions };
        }
        const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
        if (match === null) return { malformed: file };
        const front = parseYaml(match[1]) as { name: string };
        return { name: front.name, instructions: match[2] };
      }) : [];
      const expected = ['cedar', 'birch'].map((flow) => {
        const reviewer = { flow, loop: 'quality-loop', persona: 'reviewer-1' };
        const charter = `${flow} contract\n`;
        return { name: reviewerAgentFor(kind, reviewer),
          instructions: kind === 'codex' ? codexReviewerInstructions(charter) : charter };
      });
      expect.soft(actual).toEqual(expect.arrayContaining(expected));
      expect.soft(actual).toHaveLength(2);
    }
  });

  it('keeps two installed identities even when different flow names share identical reviewers', () => {
    const { dirs, agents } = fixture(false);
    const result = applyInstallExamples(dirs, []);
    if (!result.ok) throw new Error(result.error);
    for (const root of agents) expect.soft(readdirSync(root)).toHaveLength(2);
  });

  it('leaves its source trees unchanged', () => {
    const { loc, dirs } = fixture(false);
    const before = snapshotTree(loc.appPath);
    const result = applyInstallExamples(dirs, []);
    if (!result.ok) throw new Error(result.error);
    expect(snapshotTree(loc.appPath)).toEqual(before);
  });

  it('retains existing non-retired loop-only agents without overwriting them', () => {
    const { dirs, agents } = fixture(false);
    const names = ['quality-loop--reviewer-1.md', 'quality_loop__reviewer_1.toml'];
    for (const [i, root] of agents.entries()) {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, names[i]), 'An operator-owned legacy reviewer.\n');
    }
    const result = applyInstallExamples(dirs, ['agents', 'codexAgents']);
    if (!result.ok) throw new Error(result.error);
    for (const [i, root] of agents.entries()) {
      expect.soft(readFileSync(join(root, names[i]), 'utf8')).toBe('An operator-owned legacy reviewer.\n');
    }
  });
});
