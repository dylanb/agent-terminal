import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { codexReviewerAgentName } from '../../src/main/reviewerAgents';
import { reviewerHandoffLines, type ReviewerHandoffReq } from '../../src/main/reviewTurn';

// §18.1 v2.199 — the bundled Codex skill is a writer of names and paths other installed files must match: every
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

function bundledCodexAgentNames(): Set<string> {
  const names = new Set<string>();
  for (const flow of readdirSync(BUNDLE_LOOPS)) {
    for (const loop of readdirSync(path.join(BUNDLE_LOOPS, flow))) {
      const def = parseYaml(readFileSync(path.join(BUNDLE_LOOPS, flow, loop, `${loop}.yaml`), 'utf8')) as { reviewers: { persona: string }[] };
      for (const r of def.reviewers) names.add(codexReviewerAgentName(loop, r.persona));
    }
  }
  return names;
}

describe('the bundled Codex skill', () => {
  it('opens with front matter naming it after its directory and describing when to use it', () => {
    const m = /^---\n([\s\S]*?)\n---\n/.exec(skill());
    expect(m).not.toBeNull();
    const front = parseYaml(m![1]) as Record<string, unknown>;
    expect(front.name).toBe(path.basename(SKILL_DIR));
    expect(typeof front.description).toBe('string');
    expect(String(front.description).length).toBeGreaterThan(0);
  });

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
});
