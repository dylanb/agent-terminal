import { describe, expect, it } from 'vitest';
import {
  EPIC_CLASSIFICATION,
  EPIC_GRAMMAR,
  epicPlanWellFormed,
  exampleEpicPlan,
  isEpicPlan,
  parseEpicPlan,
  POLISH_REPORT_HEADING,
} from '../../src/shared/epicPlan';

// §28.7 — the epic-plan classification grammar: a serialized vocabulary with one writer (the plan-bundle work
// recipe) and readers (the gate-time classification derivation, the promotion executor, the tests). One
// definition in the shared layer so the recipe, the well-formedness predicate, and the parser cannot drift —
// the composed-prompt-is-a-writer pattern. It grades the MINIMAL contract (classified epic ⟹ ≥1 well-formed
// sub-ticket block), never a rigid layout.

describe('the classification token is spec-fixed (§28.7)', () => {
  it('is exactly "epic"', () => {
    expect(EPIC_CLASSIFICATION).toBe('epic');
  });
  it('single-sources the grammar labels the parser/predicate/example all derive from', () => {
    expect(EPIC_GRAMMAR.classification).toBe('Classification:');
    expect(EPIC_GRAMMAR.subTicket).toBe('### Sub-ticket');
    expect(EPIC_GRAMMAR.ac).toBe('Acceptance criteria:');
  });
});

describe('isEpicPlan — the classification token drives everything (§28.7)', () => {
  it('is true when the plan is classified an epic', () => {
    expect(isEpicPlan(exampleEpicPlan())).toBe(true);
  });
  it('is false for a plan with no classification line', () => {
    expect(isEpicPlan('# plan\n\njust a single-ticket plan\n')).toBe(false);
  });
  it('is false for a plan explicitly classified single-ticket', () => {
    expect(isEpicPlan('Classification: single-ticket\n\n# plan\n')).toBe(false);
  });
});

describe('exampleEpicPlan anchors the predicate (§93 canonical example)', () => {
  for (const n of [1, 2, 3]) {
    it(`generates a well-formed ${n}-sub-ticket epic plan`, () => {
      const plan = exampleEpicPlan(n);
      expect(epicPlanWellFormed(plan)).toBe(true);
      const parsed = parseEpicPlan(plan);
      expect(parsed).not.toBeNull();
      expect(parsed?.subTickets).toHaveLength(n);
    });
  }
});

describe('parseEpicPlan — ordered sub-ticket extraction (§27.10 "copied as authored")', () => {
  it('returns null for a non-epic plan', () => {
    expect(parseEpicPlan('# plan\n\nnot an epic\n')).toBeNull();
  });

  it('extracts each sub-ticket in order with its index and title', () => {
    const parsed = parseEpicPlan(exampleEpicPlan(2));
    expect(parsed?.subTickets.map((t) => t.index)).toEqual([1, 2]);
    expect(parsed?.subTickets[0].title.length).toBeGreaterThan(0);
    expect(parsed?.subTickets[1].title.length).toBeGreaterThan(0);
    // distinct titles so the preview names each distinctly
    expect(parsed?.subTickets[0].title).not.toBe(parsed?.subTickets[1].title);
  });

  it("carries each sub-ticket's authored body verbatim (the plan slice — plan-preservation)", () => {
    const plan = [
      'Classification: epic',
      '',
      '## Sub-tickets',
      '',
      '### Sub-ticket 1 — Wire the widget',
      'Acceptance criteria: the widget renders',
      '',
      'PLAN-SLICE-ONE: build the widget end to end.',
      '',
      '### Sub-ticket 2 — Remove the widget',
      'Acceptance criteria: the widget is gone',
      '',
      'PLAN-SLICE-TWO: tear the widget down.',
      '',
    ].join('\n');
    const parsed = parseEpicPlan(plan);
    expect(parsed?.subTickets[0].title).toBe('Wire the widget');
    expect(parsed?.subTickets[0].body).toContain('PLAN-SLICE-ONE: build the widget end to end.');
    expect(parsed?.subTickets[0].body).toContain('Acceptance criteria: the widget renders');
    // the first block's body must NOT bleed into the second slice's text
    expect(parsed?.subTickets[0].body).not.toContain('PLAN-SLICE-TWO');
    expect(parsed?.subTickets[1].body).toContain('PLAN-SLICE-TWO: tear the widget down.');
  });

  it('keeps a `## ` heading inside a sub-ticket body, since the body is the slice plan copied verbatim', () => {
    const plan = exampleEpicPlan(2).replace('Plan for slice 1', '## Test plan\n\nslice 1 tests after the heading\n\nPlan for slice 1');
    const body = parseEpicPlan(plan)?.subTickets[0].body ?? '';
    expect(body).toContain('## Test plan');
    expect(body).toContain('slice 1 tests after the heading');
    expect(body).toContain('Plan for slice 1');
  });

  it('ends the last sub-ticket at the polish report, so the report never reaches an issue body', () => {
    const plan = `${exampleEpicPlan(2)}\n${POLISH_REPORT_HEADING}\n\nNeeds your call: an operator-only note.\n`;
    const parsed = parseEpicPlan(plan);
    expect(parsed?.subTickets).toHaveLength(2);
    expect(parsed?.subTickets[1].body).not.toContain('Polish report');
    expect(parsed?.subTickets[1].body).not.toContain('an operator-only note');
    expect(parsed?.subTickets[1].body).toContain('Plan for slice 2');
  });

  it('preserves authored order and does not deduplicate indices (§27.10 "copied as authored")', () => {
    // A malformed authoring — out of order and a repeated index — is copied as-is, not silently reordered or
    // collapsed; the plan gate + the human judge the split, the parser does not correct it.
    const plan = [
      'Classification: epic',
      '## Sub-tickets',
      '### Sub-ticket 3 — Third',
      'Acceptance criteria: c',
      '### Sub-ticket 1 — First',
      'Acceptance criteria: a',
      '### Sub-ticket 1 — Duplicate one',
      'Acceptance criteria: a2',
      '',
    ].join('\n');
    expect(parseEpicPlan(plan)?.subTickets.map((t) => t.index)).toEqual([3, 1, 1]);
    expect(parseEpicPlan(plan)?.subTickets.map((t) => t.title)).toEqual(['Third', 'First', 'Duplicate one']);
  });
});

describe('epicPlanWellFormed — the minimal contract, never a rigid layout (§28.5.5)', () => {
  it('rejects a plan classified an epic but carrying no sub-ticket block', () => {
    expect(epicPlanWellFormed('Classification: epic\n\n## Sub-tickets\n')).toBe(false);
  });

  it('rejects a sub-ticket block missing its acceptance-criteria line', () => {
    const plan = 'Classification: epic\n\n## Sub-tickets\n\n### Sub-ticket 1 — No AC here\n\nsome plan text\n';
    expect(epicPlanWellFormed(plan)).toBe(false);
  });

  it('rejects a sub-ticket heading with no title', () => {
    const plan = 'Classification: epic\n\n## Sub-tickets\n\n### Sub-ticket 1\nAcceptance criteria: x\n';
    expect(epicPlanWellFormed(plan)).toBe(false);
  });

  it('rejects a duplicated sub-ticket index — a collision would collapse two slices onto one created issue', () => {
    // Both blocks are individually well-formed (title + AC line); the repeated index is the defect. The executor
    // keys creates on `index`, so promoting this plan creates ONE issue while the preview promised two — a silent
    // loss of an approved slice on an irreversible outward action (§28.7). The predicate must reject it at the gate.
    const plan = [
      'Classification: epic',
      '## Sub-tickets',
      '### Sub-ticket 1 — Slice A',
      'Acceptance criteria: a',
      '### Sub-ticket 1 — Slice B',
      'Acceptance criteria: b',
      '',
    ].join('\n');
    expect(epicPlanWellFormed(plan)).toBe(false);
  });

  it('accepts a well-formed epic regardless of surrounding prose (minimal contract)', () => {
    const plan = [
      '# Some heading the agent wrote',
      'Classification: epic',
      'chatter the parser tolerates',
      '## Sub-tickets',
      '### Sub-ticket 1 — Do the thing',
      'Acceptance criteria: the thing is done',
      'extra plan prose',
      '',
    ].join('\n');
    expect(epicPlanWellFormed(plan)).toBe(true);
  });
});
