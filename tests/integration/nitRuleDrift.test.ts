import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { CLEAN_RULE_LINES } from '../../src/shared/consolidatorOutput';
import { DOCUMENTATION_DEFINITION_LINES, NIT_DEFINITION_LINES } from '../../src/shared/reviewJudgement';
import { DISPOSITIONS, DOCUMENTATION_DISPOSITION, NIT_DISPOSITION } from '../../src/shared/roundReport';
import {
  BUNDLED_LOOPS_ROOT,
  REPO_DIR,
  bundledCharterFiles,
  bundledConsolidatorRecipes,
  bundledGoalLoopsWithReviewers,
} from '../helpers/bundledLoops';
import { FLOOR_EXAMPLES, FLOOR_GATE, sendsToInvalid } from '../helpers/materialityFloor';
import { specSection } from '../helpers/specSection';
import { normaliseText, sentenceStates, sentencesOf, statesText, unqualifiedOccurrences } from '../helpers/statesText';

// #207 AC 9 — every surface that no unit test pins states the one shared text, so a later edit to one copy fails
// here. The bundle is discovered, never listed; `bundledLoopsDiscovery.test.ts` counts each discovery against the
// files on disk.

describe('every bundled consolidator recipe states the shared clean rule (#207 AC 6)', () => {
  it.each(bundledConsolidatorRecipes().map((r) => [relative(BUNDLED_LOOPS_ROOT, r.path), r.path]))('%s', (_rel, path) => {
    const recipe = readFileSync(path, 'utf8');
    expect.soft(statesText(recipe, CLEAN_RULE_LINES)).toBe(true);
    expect.soft(sentenceStates(recipe, ['fixed something', '`another round`']), 'the old clean definition is still stated').toBe(false);
  });
});

describe('§27.6 states the NIT and documentation definitions and no materiality floor (#207 AC 9, AC 12)', () => {
  const section = (): string => specSection('27.6');

  it('states the NIT definition', () => {
    expect(statesText(section(), NIT_DEFINITION_LINES)).toBe(true);
  });

  it('states the definition of documentation, code comments in and flow documents out', () => {
    expect(statesText(section(), DOCUMENTATION_DEFINITION_LINES)).toBe(true);
  });

  it('states the shared clean rule, so `dismissed — nit` counts as a dismissal toward `clean`', () => {
    expect(statesText(section(), CLEAN_RULE_LINES)).toBe(true);
  });

  it('no longer states the old termination rule', () => {
    expect.soft(unqualifiedOccurrences(section(), 'changed nothing', 'except documentation')).toEqual([]);
    expect.soft(sentenceStates(section(), ['fixed something', '`another round`']), 'the old `another round` definition is still stated').toBe(false);
  });

  it('does not make changing an observable outcome the condition for fixing a finding', () => {
    expect(normaliseText(section())).not.toMatch(FLOOR_GATE);
  });

  it.each(FLOOR_EXAMPLES)('does not send %s findings to `dismissed — invalid`', (_example, pattern) => {
    expect(sendsToInvalid(section(), pattern)).toBe(false);
  });
});

describe('§27.5 lists the closed disposition set (#207 AC 9)', () => {
  it('names exactly the dispositions the format check accepts', () => {
    const lists = [...specSection('27.5').matchAll(/\((`[^`]+`(?:\s*\/\s*`[^`]+`)+)\)/g)].map((m) => [...m[1].matchAll(/`([^`]+)`/g)].map((v) => v[1]));
    expect(lists).toContainEqual([...DISPOSITIONS]);
  });
});

describe('§27.3 and §27.4 state the NIT rule where they describe the fixer and the hand-off (#207)', () => {
  it('§27.3 no longer names the materiality floor', () => {
    expect(normaliseText(specSection('27.3')).toLowerCase()).not.toContain('materiality floor');
  });

  it('§27.3 says a NIT is `dismissed — nit`, never fixed', () => {
    expect(sentenceStates(specSection('27.3'), ['NIT', `\`${NIT_DISPOSITION}\``, 'never'])).toBe(true);
  });

  it('§27.4 says the hand-off carries the NIT definition', () => {
    expect(sentenceStates(specSection('27.4'), ['hand-off', 'NIT definition'])).toBe(true);
  });

  it('§27.4 says the reviewer may label a finding a NIT', () => {
    expect(sentenceStates(specSection('27.4'), ['label', 'NIT'])).toBe(true);
  });

  it('§27.4 says the PR description is not under review', () => {
    expect(sentenceStates(specSection('27.4'), ['PR description', 'not under review'])).toBe(true);
  });
});

describe('§27.8 applies the NIT test before the polish policy (#207)', () => {
  it('says a polish finding that is a NIT is `dismissed — nit`', () => {
    expect(sentenceStates(specSection('27.8'), ['polish', 'NIT', `\`${NIT_DISPOSITION}\``])).toBe(true);
  });
});

describe("the Codex skill's judging step states the shared clean rule (#207 AC 6, scope 11)", () => {
  it('states it in step 4', () => {
    const skill = readFileSync(join(REPO_DIR, 'example', 'codex-skills', 'agent-terminal-loops', 'SKILL.md'), 'utf8');
    const step4 = /^4\. \*\*Judge the round\.\*\*[\s\S]*?(?=^## )/m.exec(skill)?.[0] ?? '';
    expect(step4, 'the skill has no step 4 "Judge the round"').not.toBe('');
    expect(statesText(step4, CLEAN_RULE_LINES)).toBe(true);
  });
});

describe('groom-goal-loop stops on a pass with no findings other than NITs (#207 AC 8)', () => {
  const groom = (): ReturnType<typeof bundledGoalLoopsWithReviewers>[number] => {
    const found = bundledGoalLoopsWithReviewers().find((g) => g.loop === 'groom-goal-loop');
    if (found === undefined) throw new Error('no bundled groom-goal-loop');
    return found;
  };
  const surfaces: [string, () => string][] = [
    ['its work.goal', () => groom().def.work.goal ?? ''],
    ['its prompts/work.md', () => readFileSync(groom().def.work.recipe, 'utf8')],
  ];

  it.each(surfaces)('%s says "no findings" only as "no findings other than NITs"', (_surface, text) => {
    expect.soft(unqualifiedOccurrences(text(), 'no findings', 'other than NITs')).toEqual([]);
    expect.soft(normaliseText(text())).toContain('no findings other than NITs');
  });

  it('its prompts/work.md logs each NIT as `dismissed — nit` in groom-report.md\'s review history', () => {
    const work = readFileSync(groom().def.work.recipe, 'utf8').toLowerCase();
    expect(sentenceStates(work, [`\`${NIT_DISPOSITION}\``, 'groom-report.md', 'review history'])).toBe(true);
  });
});

// Each goal loop whose subject is not a flow document stops on a pass whose only fixes are documentation. The
// two exclusions grade a flow document, which is never documentation (scope 14).
const FLOW_DOCUMENT_GOAL_LOOPS = ['groom-goal-loop', 'plan-goal-loop'];
const DOC_ONLY_EXCEPTION = `other than documentation-only fixes recorded as \`${DOCUMENTATION_DISPOSITION}\``;

describe('every bundled goal loop whose subject is code ends on a documentation-only pass (#207 AC 11)', () => {
  const goalLoops = bundledGoalLoopsWithReviewers();
  const checked = goalLoops.filter((g) => !FLOW_DOCUMENT_GOAL_LOOPS.includes(g.loop));

  it('discovers both named exclusions and at least one loop to check', () => {
    expect(goalLoops.map((g) => g.loop)).toEqual(expect.arrayContaining(FLOW_DOCUMENT_GOAL_LOOPS));
    expect(checked.length).toBe(goalLoops.length - FLOW_DOCUMENT_GOAL_LOOPS.length);
    expect(checked.length).toBeGreaterThan(0);
  });

  const surfaces = checked.flatMap((g) => [
    [`${g.flow}/${g.loop} work.goal`, g.def.work.goal ?? ''],
    ...g.promptFiles.map((f) => [relative(BUNDLED_LOOPS_ROOT, f), readFileSync(f, 'utf8')]),
  ]);

  it.each(surfaces)('%s says "nothing left to fix" only with the documentation-only exception', (_surface, text) => {
    expect.soft(unqualifiedOccurrences(text, 'nothing left to fix', DOC_ONLY_EXCEPTION)).toEqual([]);
    expect.soft(normaliseText(text)).toContain(`nothing left to fix ${DOC_ONLY_EXCEPTION}`);
  });
});

// The two kept texts are not materiality rules (scope 11): a decision-authority rule and the §28.8.1 altitude rule.
const KEPT_NOT_A_FINDING = ['is not a finding because you would have chosen differently', 'is not a finding about that defect'];
const MATERIALITY_MARKERS = ['raise a finding only where', 'is not a finding'];

/** Each materiality marker `text` still states, once the kept texts are removed. */
function materialityRules(text: string): string[] {
  const rest = KEPT_NOT_A_FINDING.reduce((t, kept) => t.replaceAll(kept, ''), normaliseText(text).toLowerCase());
  return MATERIALITY_MARKERS.filter((m) => rest.includes(m));
}

describe('the charter materiality check itself', () => {
  it('finds a charter materiality paragraph', () => {
    const paragraph =
      'Raise a finding only where acting on it changes an observable outcome. A citation already correct, an equal-quality rewording, or a defensible authoring choice the ticket does not require is not a finding.';
    expect(materialityRules(paragraph)).toEqual(MATERIALITY_MARKERS);
  });

  it.each([
    ["groom-goal-loop's intent charter", join('feature-dev-v3', 'groom-goal-loop', 'charter', 'intent.md')],
    ...['principal', 'intent', 'tracer-slicer'].map((p) => [`the plan-bundle-loop ${p} charter`, join('feature-dev-v2', 'plan-bundle-loop', 'charter', `${p}.md`)]),
  ])('passes the kept text in %s', (_name, rel) => {
    const charter = readFileSync(join(BUNDLED_LOOPS_ROOT, rel), 'utf8');
    const sentences = sentencesOf(charter);
    const keptSentences = sentences.filter((s) => KEPT_NOT_A_FINDING.some((k) => s.toLowerCase().includes(k)));
    expect(keptSentences.length).toBeGreaterThan(0);
    expect(materialityRules(keptSentences.join(' '))).toEqual([]);
  });

  it('passes the "nits" persona line and the tracer-slicer sizing line', () => {
    expect(materialityRules('You are also embarrassed when you raise issues that are nits that another principal engineer might disagree with.')).toEqual([]);
    expect(materialityRules('slice count and size are the planner’s call, never a finding, so')).toEqual([]);
  });
});

describe('no bundled charter states its own materiality rule (#207 AC 9)', () => {
  it.each(bundledCharterFiles().map((f) => [relative(BUNDLED_LOOPS_ROOT, f), f]))('%s', (_rel, path) => {
    expect(materialityRules(readFileSync(path, 'utf8'))).toEqual([]);
  });
});

describe('CLAUDE.md carries the PR-description push rule (#207 AC 10)', () => {
  it('brings the PR description up to date on every push to a branch that has a PR', () => {
    const claude = readFileSync(join(REPO_DIR, 'CLAUDE.md'), 'utf8');
    expect(sentenceStates(claude, ['every push', 'PR', 'PR description', 'test evidence', 'history', 'same step'])).toBe(true);
  });
});
