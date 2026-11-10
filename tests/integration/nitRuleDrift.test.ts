import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { CLEAN_RULE_LINES } from '../../src/shared/consolidatorOutput';
import { composeConsolidatePrompt } from '../../src/main/consolidateTurn';
import { GOAL_NO_CHANGE_CLAUSE } from '../../src/main/reviewTurn';
import { DOCUMENTATION_DEFINITION_LINES, NIT_DEFINITION_LINES } from '../../src/shared/reviewJudgement';
import { DISPOSITIONS, NIT_DISPOSITION } from '../../src/shared/roundReport';
import {
  BUNDLED_LOOPS_ROOT,
  REPO_DIR,
  bundledCharterFiles,
  bundledConsolidatorRecipes,
  bundledGoalLoopsWithReviewers,
} from '../helpers/bundledLoops';
import { FLOOR_EXAMPLES, sendsToInvalid, statesFloorGate } from '../helpers/materialityFloor';
import { specSection } from '../helpers/specSection';
import { sentenceStates, sentencesOf, statesText, timesStated, unqualifiedOccurrences } from '../helpers/statesText';

// #207 AC 9 — a later edit to one copy of a shared text fails here.

describe("every bundled consolidator recipe judges `clean` by the engine's clean rule alone (#207 AC 6)", () => {
  it.each(bundledConsolidatorRecipes().map((r) => [relative(BUNDLED_LOOPS_ROOT, r.path), r.path]))('%s', (_rel, path) => {
    const recipe = readFileSync(path, 'utf8');
    const prompt = composeConsolidatePrompt({
      recipeBody: recipe,
      catalog: ['principal'],
      reportRels: ['.agent-terminal/loop/reports/1.json'],
      outputRel: '.agent-terminal/loop/consolidator.json',
      round: 1,
      turnKey: 'consolidate-x',
      doneRelPath: '.agent-terminal/loop/turn-done',
    });
    expect.soft(timesStated(prompt, CLEAN_RULE_LINES), 'the composed prompt states the clean rule exactly once').toBe(1);
    for (const sentence of sentencesOf(CLEAN_RULE_LINES.join('\n'))) {
      expect.soft(statesText(recipe, sentence), `the recipe restates a sentence of the clean rule: ${sentence}`).toBe(false);
    }
    expect.soft(sentenceStates(recipe, ['`clean`', 'turn instruction']), "the `clean` bullet defers to the turn instruction's rule").toBe(true);
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
    expect(statesFloorGate(section())).toBe(false);
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
    expect(statesText(specSection('27.3'), 'materiality floor', { ignoreCase: true })).toBe(false);
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

// #207 AC 8, AC 11 — a goal loop's stop condition is the shared no-change clause, which counts documentation as no
// change; a NIT is dismissed, so a NIT-only pass changes nothing.
const RETIRED_STOP_CONDITIONS = ['nothing left to fix', 'no findings other than NITs'];

describe('every bundled goal loop ends its review on the shared no-change clause (#207 AC 8, AC 11)', () => {
  const goalLoops = bundledGoalLoopsWithReviewers();

  it.each(goalLoops.map((g) => [`${g.flow}/${g.loop}`, g.goal]))('%s work.goal states the shared clause', (_loop, goal) => {
    expect(statesText(goal, GOAL_NO_CHANGE_CLAUSE)).toBe(true);
  });

  const surfaces = goalLoops.flatMap((g) => [
    [`${g.flow}/${g.loop} work.goal`, g.goal],
    ...g.promptFiles.map((f) => [relative(BUNDLED_LOOPS_ROOT, f), readFileSync(f, 'utf8')]),
  ]);

  it.each(surfaces)('%s states no stop condition of its own', (_surface, text) => {
    for (const retired of RETIRED_STOP_CONDITIONS) expect.soft(statesText(text, retired, { ignoreCase: true }), retired).toBe(false);
  });

  it("groom-goal-loop's prompts/work.md logs each NIT as `dismissed — nit` in groom-report.md's review history", () => {
    const groom = goalLoops.find((g) => g.loop === 'groom-goal-loop');
    expect(groom).toBeDefined();
    const work = readFileSync(groom?.workRecipe ?? '', 'utf8');
    expect(sentenceStates(work, [`\`${NIT_DISPOSITION}\``, 'groom-report.md', 'review history'], { ignoreCase: true })).toBe(true);
  });
});

// The two kept texts are not materiality rules: a decision-authority rule and the §28.8.1 altitude rule.
const KEPT_NOT_A_FINDING = ['is not a finding because you would have chosen differently', 'is not a finding about that defect', 'is not a finding for this lens'];
const MATERIALITY_MARKERS = ['raise a finding only where', 'is not a finding'];

/** Each materiality marker `text` states more often than the kept texts that contain it account for. */
function materialityRules(text: string): string[] {
  const anyCase = { ignoreCase: true };
  const kept = (marker: string): number =>
    KEPT_NOT_A_FINDING.filter((k) => k.includes(marker)).reduce((n, k) => n + timesStated(text, k, anyCase), 0);
  return MATERIALITY_MARKERS.filter((m) => timesStated(text, m, anyCase) > kept(m));
}

describe('the charter materiality check itself', () => {
  it('finds a charter materiality paragraph', () => {
    const paragraph =
      'Raise a finding only where acting on it changes an observable outcome. A citation already correct, an equal-quality rewording, or a defensible authoring choice the ticket does not require is not a finding.';
    expect(materialityRules(paragraph)).toEqual(MATERIALITY_MARKERS);
  });

  it.each([
    ["groom-goal-loop's intent charter", join('feature-dev-v3', 'groom-goal-loop', 'charter', 'intent.md')],
    ...['tests', 'red-authenticity'].map((p) => [`the red-loop ${p} charter`, join('feature-dev-v3', 'red-loop', 'charter', `${p}.md`)]),
  ])('passes the kept text in %s', (_name, rel) => {
    const charter = readFileSync(join(BUNDLED_LOOPS_ROOT, rel), 'utf8');
    const sentences = sentencesOf(charter);
    const keptSentences = sentences.filter((s) => KEPT_NOT_A_FINDING.some((k) => statesText(s, k, { ignoreCase: true })));
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
