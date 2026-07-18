import { describe, expect, it } from 'vitest';
import {
  artifactWellFormed,
  boundaryCommand,
  completionArtifact,
  completionMarker,
  composeAppWorkPrompt,
} from '../../src/main/appWorkTurn';
import type { BoundaryPolicy, LoopDefV2 } from '../../src/main/loopDefV2';

// §27.7/§27.8/§27.12 — the pure, data-driven pieces of the §27 work turn: the boundary-policy→command
// mapping, the completion-artifact resolver (read from the def's declared artifact, NOT a hard-coded loop
// name), the completion marker the prompt instructs and the checker reads (one definition, so writer↔reader
// cannot desync), and the work-prompt composer. No fs, no engine — asserted purely from the outside.

function def(over: Partial<LoopDefV2>): LoopDefV2 {
  return {
    version: 'v2',
    name: 'plan-loop',
    origin: 'app-bundled',
    work: { recipe: '/abs/prompts/work.md', artifact: 'plan' },
    reviewers: [],
    consolidator: '/abs/prompts/consolidate.md',
    boundaries: [],
    report: { sections: ['summary'] },
    gate: [],
    pickup: { initialStatus: 'planning', branchTemplate: 'plan-loop/issue-{issue}' },
    inputs: [],
    outputs: [{ id: 'plan', path: '/abs/repo/.agent-terminal/loop/artifacts/plan.md' }],
    exec: null,
    ...over,
  };
}

describe('boundaryCommand (§27.7 — boundaries are data)', () => {
  it('maps a clear boundary to the /clear command', () => {
    const policy: BoundaryPolicy = { boundary: 'pre-work', mode: 'clear' };
    expect(boundaryCommand(policy)).toBe('/clear');
  });

  it('maps a compact boundary to /compact carrying the def message (§27.12b graded observable)', () => {
    const policy: BoundaryPolicy = { boundary: 'pre-work', mode: 'compact', message: 'Keep the plan and the ticket.' };
    expect(boundaryCommand(policy)).toBe('/compact Keep the plan and the ticket.');
  });

  it('two defs declaring different boundaries issue their respective commands', () => {
    expect(boundaryCommand({ boundary: 'a', mode: 'clear' })).not.toBe(
      boundaryCommand({ boundary: 'b', mode: 'compact', message: 'x' }),
    );
  });
});

describe('completionArtifact (§27.12 — file-producing vs commit-producing, data-driven)', () => {
  it('resolves the confined output path whose id matches the work artifact (file-producing)', () => {
    const d = def({ work: { recipe: '/abs/prompts/work.md', artifact: 'plan' } });
    expect(completionArtifact(d)).toEqual({ path: '/abs/repo/.agent-terminal/loop/artifacts/plan.md' });
  });

  it('returns null when the work artifact id has no matching output binding (commit-producing)', () => {
    // A loop whose product is commits declares no output file for its work artifact → advance on the
    // done-signal alone. Read from the def, never a hard-coded loop name.
    const d = def({ work: { recipe: '/abs/prompts/work.md', artifact: 'commits' }, outputs: [] });
    expect(completionArtifact(d)).toBeNull();
  });
});

describe('completionMarker (§27.12 — the well-formedness marker, one definition)', () => {
  it('is a stable one-line marker carrying the step name', () => {
    const m = completionMarker('plan');
    expect(m).toContain('plan');
    expect(m).not.toContain('\n');
    // Stable across retries of the same step (the marker anchors on the step, not a per-attempt nonce).
    expect(completionMarker('plan')).toBe(m);
  });

  it('differs between steps so one step\'s marker never satisfies another', () => {
    expect(completionMarker('plan')).not.toBe(completionMarker('impl'));
  });
});

describe('artifactWellFormed (§27.12 — present AND carrying the marker, never a quality judgment)', () => {
  const marker = completionMarker('plan');
  it('is true only when the content is present and contains the marker', () => {
    expect(artifactWellFormed(`# plan\n${marker}\n`, marker)).toBe(true);
  });
  it('is false when the artifact is absent (null content)', () => {
    expect(artifactWellFormed(null, marker)).toBe(false);
  });
  it('is false when present but missing the marker (drives one retry then error)', () => {
    expect(artifactWellFormed('# plan\nno marker here\n', marker)).toBe(false);
  });
});

describe('composeAppWorkPrompt (§27.3/§27.12 — recipe + marker + done-signal)', () => {
  it('for a file-producing turn: names the artifact, the marker, and the §27 done-file path', () => {
    const prompt = composeAppWorkPrompt({
      recipeBody: '# work turn\nImplement the plan.',
      turnKey: 'work-plan',
      doneRelPath: '.agent-terminal/loop/turn-done',
      completion: { artifactRel: '.agent-terminal/loop/artifacts/plan.md', marker: completionMarker('plan') },
    });
    expect(prompt).toContain('Implement the plan.'); // the recipe body survives
    expect(prompt).toContain('.agent-terminal/loop/artifacts/plan.md'); // the artifact to produce
    expect(prompt).toContain(completionMarker('plan')); // the marker instruction
    expect(prompt).toContain('.agent-terminal/loop/turn-done'); // the §27 done-file, not §26's .agent-loop
    expect(prompt).toContain('turn-done:work-plan'); // the turn id token the fake-agent matches
    expect(prompt).not.toContain('.agent-loop/turn-done'); // NOT the §26 path (AC10 separation)
  });

  it('for a commit-producing turn: no marker/artifact, completes on the done-signal alone', () => {
    const prompt = composeAppWorkPrompt({
      recipeBody: '# work turn\nShip commits.',
      turnKey: 'work-impl',
      doneRelPath: '.agent-terminal/loop/turn-done',
      completion: null,
    });
    expect(prompt).toContain('Ship commits.');
    expect(prompt).toContain('turn-done:work-impl');
    expect(prompt.toLowerCase()).not.toContain('re-read'); // no artifact verification clause
  });
});
