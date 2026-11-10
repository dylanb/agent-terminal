import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { codexAgentsDir, codexLoopsV2Dir } from '../../src/main/codexConfig';
import { CODEX_REVIEWER_AGENT, planReviewerAgents } from '../../src/main/reviewerAgents';
import { fixCriterionLines, reviewerHandoffLines, type ReviewerHandoffReq } from '../../src/main/reviewTurn';

// §18.1 — the bundled Codex skill is a writer of names and paths other installed files must match: every
// agent name and loop path it gives as an example is checked against the bundle, so a renamed convention breaks
// this test rather than the Codex session that follows the skill.
const SKILL_DIR = path.resolve('example', 'codex-skills', 'agent-terminal-loops');
const BUNDLE_LOOPS = path.resolve('example', 'loops-v2');
const skill = (): string => readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');

// §27.4 v2.198 — the skill's hand-off is the engine's, with each value the engine fills in written as a placeholder.
const PLACEHOLDERS: [string, string][] = [
  ['424242', '<n>'],
  ['SUBJECT_PATH', '<artifact>'],
  ['717171', '<slice>'],
  ['INPUT_ID', '<input-id>'],
  ['INPUT_PATH', '<input-path>'],
];
const HANDOFF_VARIANTS: ReviewerHandoffReq[] = [
  { ticket: 424242, carried: [] },
  { carried: [] },
  { ticket: 424242, subjectRel: 'SUBJECT_PATH', carried: [] },
  { ticket: 424242, slice: 717171, carried: [{ id: 'INPUT_ID', rel: 'INPUT_PATH' }] },
];
const engineHandoffLines = (): Set<string> =>
  new Set(
    HANDOFF_VARIANTS.flatMap((h) => reviewerHandoffLines(h))
      .map((line) => PLACEHOLDERS.reduce((l, [value, placeholder]) => l.replaceAll(value, placeholder), line))
      .filter((line) => line.trim() !== ''),
  );
const skillHandoffLines = (): Set<string> =>
  new Set([...skill().matchAll(/^ *```text\n([\s\S]*?)^ *```$/gm)].flatMap((m) => m[1].split('\n')).map((l) => l.replace(/^ {3}/, '')).filter((l) => l.trim() !== ''));

// #207 — the skill's fix step is the engine's fixer criterion, in its own labelled block so the hand-off reader
// above never takes it for hand-off text.
const FIX_CRITERION_FENCE = 'fix-criterion';
const nonBlank = (lines: string[]): Set<string> => new Set(lines.filter((l) => l.trim() !== ''));
const skillFixCriterionLines = (): Set<string> =>
  nonBlank(
    [...skill().matchAll(new RegExp(`^ *\`\`\`${FIX_CRITERION_FENCE}\n([\\s\\S]*?)^ *\`\`\`$`, 'gm'))]
      .flatMap((m) => m[1].split('\n'))
      .map((l) => l.replace(/^ {3}/, '')),
  );

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

  it("hands each reviewer the engine's own hand-off lines, and no line of its own", () => {
    const engine = engineHandoffLines();
    const skilled = skillHandoffLines();
    for (const line of engine) expect(skilled.has(line), line).toBe(true);
    for (const line of skilled) expect(engine.has(line), line).toBe(true);
  });

  it("states the engine's own fixer criterion in its fix step, and no line of its own (#207 AC 9, AC 12)", () => {
    const engine = nonBlank(fixCriterionLines());
    const skilled = skillFixCriterionLines();
    expect.soft([...engine].filter((line) => !skilled.has(line)), 'engine lines missing from the skill').toEqual([]);
    expect.soft([...skilled].filter((line) => !engine.has(line)), 'skill lines the engine does not have').toEqual([]);
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
