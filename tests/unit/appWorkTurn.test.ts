import { describe, expect, it } from 'vitest';
import {
  artifactWellFormed,
  boundaryCommand,
  completionArtifact,
  completionMarker,
  composeAppWorkPrompt,
  presentChainedInputs,
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

  it('resolves by artifact id, not list position, when the matching output is not first', () => {
    const d = def({
      work: { recipe: '/abs/prompts/work.md', artifact: 'plan' },
      outputs: [
        { id: 'diff', path: '/abs/repo/.agent-terminal/loop/artifacts/diff.md' },
        { id: 'plan', path: '/abs/repo/.agent-terminal/loop/artifacts/plan.md' },
      ],
    });
    expect(completionArtifact(d)).toEqual({ path: '/abs/repo/.agent-terminal/loop/artifacts/plan.md' });
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

describe('presentChainedInputs (§27.10/§18.4 — declared inputs an upstream loop produced, present-gated)', () => {
  it('carries {id, artifactRel} for each declared input the presence predicate accepts, in declaration order', () => {
    const d = def({
      inputs: [
        { id: 'plan', path: '/abs/repo/.agent-terminal/loop/artifacts/plan.md' },
        { id: 'notes', path: '/abs/repo/.agent-terminal/loop/artifacts/notes.md' },
      ],
    });
    expect(presentChainedInputs(d, '/abs/repo', () => true)).toEqual([
      { id: 'plan', artifactRel: '.agent-terminal/loop/artifacts/plan.md' },
      { id: 'notes', artifactRel: '.agent-terminal/loop/artifacts/notes.md' },
    ]);
  });

  it('filters per-element: keeps only inputs whose artifact the predicate finds present', () => {
    const d = def({
      inputs: [
        { id: 'plan', path: '/abs/repo/.agent-terminal/loop/artifacts/plan.md' },
        { id: 'notes', path: '/abs/repo/.agent-terminal/loop/artifacts/notes.md' },
      ],
    });
    const present = presentChainedInputs(
      d,
      '/abs/repo',
      (p) => p === '/abs/repo/.agent-terminal/loop/artifacts/plan.md',
    );
    expect(present).toEqual([{ id: 'plan', artifactRel: '.agent-terminal/loop/artifacts/plan.md' }]);
  });

  it('probes each declared input at its confined absolute path (never a repo-relative re-join — CWE-22)', () => {
    const d = def({ inputs: [{ id: 'plan', path: '/abs/repo/.agent-terminal/loop/artifacts/plan.md' }] });
    const probed: string[] = [];
    presentChainedInputs(d, '/abs/repo', (p) => {
      probed.push(p);
      return true;
    });
    expect(probed).toEqual(['/abs/repo/.agent-terminal/loop/artifacts/plan.md']);
  });

  it('is empty for a loop that declares no inputs (the first loop in a chain)', () => {
    expect(presentChainedInputs(def({ inputs: [] }), '/abs/repo', () => true)).toEqual([]);
  });
});

describe('composeAppWorkPrompt (§27.3/§27.12 — recipe + marker + done-signal)', () => {
  it('§27.10/§18.4 — a chained input names each carried artifact id and its repo-relative path', () => {
    const prompt = composeAppWorkPrompt({
      recipeBody: '# work turn\nImplement the plan.',
      turnKey: 'work-implement',
      doneRelPath: '.agent-terminal/loop/turn-done',
      completion: { artifactRel: '.agent-terminal/loop/artifacts/diff.md', marker: completionMarker('implement') },
      inputs: [{ id: 'plan', artifactRel: '.agent-terminal/loop/artifacts/plan.md' }],
    });
    expect(prompt).toContain('Implement the plan.'); // the recipe body still leads
    expect(prompt).toContain('- plan: .agent-terminal/loop/artifacts/plan.md'); // the carried input, id + path
    expect(prompt.toLowerCase()).toContain('previous loop'); // framed as material from the prior loop
  });

  it('§27.10 — no chained-input block on a loop entered with no inputs', () => {
    const prompt = composeAppWorkPrompt({
      recipeBody: '# work turn\nGroom the ticket.',
      turnKey: 'work-groom',
      doneRelPath: '.agent-terminal/loop/turn-done',
      completion: { artifactRel: '.agent-terminal/loop/artifacts/groomed-ticket.md', marker: completionMarker('groom') },
      inputs: [],
    });
    expect(prompt.toLowerCase()).not.toContain('previous loop');
  });

  it('§27.10 — the chained input survives alongside a redo instruction (recipe → inputs → redo)', () => {
    const prompt = composeAppWorkPrompt({
      recipeBody: '# work turn\nImplement the plan.',
      turnKey: 'work-implement',
      doneRelPath: '.agent-terminal/loop/turn-done',
      completion: null,
      inputs: [{ id: 'plan', artifactRel: '.agent-terminal/loop/artifacts/plan.md' }],
      instruction: 'Keep only the schema section.',
    });
    expect(prompt).toContain('- plan: .agent-terminal/loop/artifacts/plan.md'); // the carried input
    expect(prompt).toContain('Keep only the schema section.'); // the redo instruction
    expect(prompt.indexOf('plan.md')).toBeLessThan(prompt.indexOf('Keep only the schema section.')); // inputs above redo
  });
});

describe('composeAppWorkPrompt (§27.3/§27.12 — recipe + marker + done-signal, no chained input)', () => {
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

  it('§27.9/AC5 — a redo instruction is threaded into the work prompt as a clean-slate directive', () => {
    const INSTRUCTION = 'The structure is wrong — redo it keeping only the schema section.';
    const prompt = composeAppWorkPrompt({
      recipeBody: '# work turn\nImplement the plan.',
      turnKey: 'work-plan',
      doneRelPath: '.agent-terminal/loop/turn-done',
      completion: { artifactRel: '.agent-terminal/loop/artifacts/plan.md', marker: completionMarker('plan') },
      instruction: INSTRUCTION,
    });
    expect(prompt).toContain('Implement the plan.'); // the recipe body still leads (ticket + plan inputs)
    expect(prompt).toContain(INSTRUCTION); // the operator's instruction rides along
    expect(prompt.toLowerCase()).toContain('redo'); // framed as a redo, not an ordinary work run
  });

  it('§27.9/AC5 — no redo block on an ordinary work run (absent instruction = none)', () => {
    const prompt = composeAppWorkPrompt({
      recipeBody: '# work turn\nImplement the plan.',
      turnKey: 'work-plan',
      doneRelPath: '.agent-terminal/loop/turn-done',
      completion: { artifactRel: '.agent-terminal/loop/artifacts/plan.md', marker: completionMarker('plan') },
    });
    expect(prompt.toLowerCase()).not.toContain('redo');
  });
});
