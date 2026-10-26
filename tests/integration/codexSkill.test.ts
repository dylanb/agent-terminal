import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { codexAgentsDir, codexLoopsV2Dir } from '../../src/main/codexConfig';
import { CODEX_REVIEWER_AGENT, planReviewerAgents } from '../../src/main/reviewerAgents';

// §18.1 — the bundled Codex skill is a writer of names and paths other installed files must match: every
// agent name and loop path it gives as an example is checked against the bundle, so a renamed convention breaks
// this test rather than the Codex session that follows the skill.
const SKILL_DIR = path.resolve('example', 'codex-skills', 'agent-terminal-loops');
const BUNDLE_LOOPS = path.resolve('example', 'loops-v2');
const skill = (): string => readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');

const bundledCodexAgentNames = (): Set<string> =>
  new Set(planReviewerAgents(BUNDLE_LOOPS, CODEX_REVIEWER_AGENT).map((a) => path.basename(a.rel, CODEX_REVIEWER_AGENT.extension)));

describe('the bundled Codex skill', () => {
  it('gives as examples only agent names a bundled reviewer is installed under', () => {
    const examples = [...skill().matchAll(/`([a-z0-9]+(?:_[a-z0-9]+)*__[a-z0-9_]+)`/g)].map((m) => m[1]);
    expect(examples.length).toBeGreaterThan(0);
    const installed = bundledCodexAgentNames();
    for (const name of examples) expect(installed.has(name), name).toBe(true);
  });

  it('gives as examples only loop definition paths the bundle installs', () => {
    const examples = [...skill().matchAll(/`loops-v2\/([^`<>]+\.yaml)`/g)].map((m) => m[1]);
    expect(examples.length).toBeGreaterThan(0);
    for (const rel of examples) expect(existsSync(path.join(BUNDLE_LOOPS, rel)), rel).toBe(true);
  });

  it('names the Codex home directories the installer writes the loops and the reviewer agents to', () => {
    const home = path.resolve('/codex-home');
    for (const dir of [codexLoopsV2Dir(home), codexAgentsDir(home)]) {
      expect(skill()).toContain(`\`<codex home>/${path.relative(home, dir)}/`);
    }
  });

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
