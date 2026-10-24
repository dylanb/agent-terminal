import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUNDLED_LOOPS_ROOT, REPO_DIR, resolveBundledLoop } from '../helpers/bundledLoops';
import { composeAppWorkPrompt } from '../../src/main/appWorkTurn';
import { reviewRoster } from '../../src/main/reviewTurn';
import { CLAUDE_REVIEWER_AGENT, planReviewerAgents, reviewerAgentName } from '../../src/main/reviewerAgents';
import type { LoopDefV2 } from '../../src/main/loopDefV2';

// #246 — both planners plan the design system first, both plan loops review a plan's UI, and every plan reviewer
// that grades slicing applies TRACER-BULLET.md's design-system note. Observed at what each turn is actually given:
// the composed work prompt, the review roster, and the reviewer sub-agent the installer renders from a charter.

const PLANNERS = ['plan-goal-loop', 'plan-loop'] as const;
const UI_PERSONA = 'review-plan-ui';
const SLICING_REVIEWERS: readonly { loop: string; persona: string }[] = [
  { loop: 'plan-goal-loop', persona: 'review-plan-tracer-slicer' },
  { loop: 'plan-goal-loop', persona: 'review-plan-principal' },
  { loop: 'plan-loop', persona: 'review-plan-principal' },
];

const DESIGN_SYSTEM_SLICE_ACCEPTED =
  'A slice whose main content is design-system work is a vertical slice when it applies that work to a surface that already exists, so the change is visible in the running app, and proves it RED-first through a real browser or the `_electron` e2e.';
const DESIGN_SYSTEM_SLICE_REJECTED = 'A slice that adds tokens or shared components that nothing visible uses is still a horizontal layer.';

const PLANNER_REQUIREMENTS = [
  'When the ticket touches renderer UI, the plan carries a `## Design system` section',
  'or states `None.` when it needs none',
  'A ticket that does not touch renderer UI omits the section.',
  'in the earliest slice or slices, ahead of every slice that uses it',
  'Never plan a component-specific colour, spacing or typography value where a token should exist',
];

const flat = (s: string): string => s.replace(/\s+/g, ' ');

function def(loop: string): LoopDefV2 {
  const r = resolveBundledLoop(loop);
  if (!r.ok) throw new Error(r.reason);
  return r.def;
}

function composedWorkPrompt(d: LoopDefV2): string {
  return composeAppWorkPrompt({
    recipeBody: readFileSync(d.work.recipe, 'utf8'),
    ...(d.brief !== undefined ? { loopBrief: readFileSync(d.brief, 'utf8') } : {}),
    turnKey: 'work-plan',
    doneRelPath: '.agent-terminal/loop/turn-done',
    completion: { kind: 'file', artifactRel: 'plan.md', marker: '<!-- done -->' },
  });
}

const renderedAgents = new Map(planReviewerAgents(BUNDLED_LOOPS_ROOT, CLAUDE_REVIEWER_AGENT).map((a) => [a.rel, a]));
function renderedReviewer(loop: string, persona: string): string {
  const agent = renderedAgents.get(`${reviewerAgentName(loop, persona)}${CLAUDE_REVIEWER_AGENT.extension}`);
  if (agent === undefined) throw new Error(`no reviewer sub-agent is installed for ${loop} ${persona}`);
  return agent.bytes().toString('utf8');
}

const STANDARDS_LEAD = 'Standards to apply:';
function uiStandards(d: LoopDefV2): string {
  const ui = d.reviewers.find((r) => r.persona === UI_PERSONA);
  if (ui === undefined) throw new Error(`${d.name} has no ${UI_PERSONA} reviewer`);
  const para = readFileSync(ui.charter, 'utf8')
    .split(/\n\s*\n/)
    .find((p) => p.startsWith(STANDARDS_LEAD));
  if (para === undefined) throw new Error(`${d.name}'s ${UI_PERSONA} charter has no standards paragraph`);
  return flat(para.slice(STANDARDS_LEAD.length)).trim();
}

describe('both planners plan the design system first (#246)', () => {
  for (const loop of PLANNERS) {
    it(`${loop}: the composed work prompt requires the design-system section, scheduled first, with no one-off styling`, () => {
      const prompt = flat(composedWorkPrompt(def(loop)));
      for (const requirement of PLANNER_REQUIREMENTS) expect(prompt, requirement).toContain(requirement);
    });

    it(`${loop}: the brief names the UI reviewer and the standards it grades against`, () => {
      const d = def(loop);
      const brief = flat(readFileSync(d.brief!, 'utf8'));
      expect(brief).toContain('**ui:**');
      expect(brief).toContain(uiStandards(d));
    });
  }
});

describe('both plan loops review a plan with the UI reviewer (#246)', () => {
  for (const loop of PLANNERS) {
    it(`${loop}: the review roster includes ${UI_PERSONA} beside the existing reviewers`, () => {
      const personas = reviewRoster(def(loop)).map((r) => r.persona);
      expect(personas).toContain(UI_PERSONA);
      expect(personas).toContain('review-plan-principal');
    });

    it(`${loop}: the installed UI reviewer grades design-system completeness, ordering, tokens, tiers and WCAG 2.2 AA through a real browser`, () => {
      const charter = flat(renderedReviewer(loop, UI_PERSONA));
      for (const needle of [
        'Design-system-first',
        '`## Design system`',
        'ahead of every slice that uses it',
        'one-off colour, spacing or typography value',
        '`UI-STANDARDS.md`',
        'both light and dark themes',
        'SC 1.4.3',
        'SC 1.4.11',
        'SC 2.1.1',
        'SC 2.4.3',
        'SC 2.4.7',
        'SC 4.1.2',
        'never by parsing CSS',
        'For a plan that does not touch renderer UI, return clean.',
        'Raise a finding only where',
        'beyond what the ticket requires',
      ]) {
        expect(charter, needle).toContain(needle);
      }
    });
  }
});

describe('TRACER-BULLET.md says when a design-system slice is vertical, and every slicing reviewer applies it (#246)', () => {
  it('TRACER-BULLET.md carries the design-system note', () => {
    const doc = flat(readFileSync(join(REPO_DIR, 'TRACER-BULLET.md'), 'utf8'));
    expect(doc).toContain(DESIGN_SYSTEM_SLICE_ACCEPTED);
    expect(doc).toContain(DESIGN_SYSTEM_SLICE_REJECTED);
  });

  for (const { loop, persona } of SLICING_REVIEWERS) {
    it(`${loop} ${persona}: the installed charter accepts a design-system first slice that meets the note and rejects one that does not`, () => {
      const charter = flat(renderedReviewer(loop, persona));
      expect(charter).toContain(DESIGN_SYSTEM_SLICE_ACCEPTED);
      expect(charter).toContain(DESIGN_SYSTEM_SLICE_REJECTED);
    });
  }
});
