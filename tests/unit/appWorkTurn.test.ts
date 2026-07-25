import { describe, expect, it } from 'vitest';
import {
  artifactWellFormed,
  boundaryCommand,
  completionArtifact,
  completionMarker,
  composeAppWorkPrompt,
} from '../../src/main/appWorkTurn';
import { resolveChainedInputs } from '../../src/main/chainedInput';
import type { BoundaryPolicy, LoopDefV2 } from '../../src/main/loopDefV2';

// §27.7/§27.8/§27.12 — the pure, data-driven pieces of the §27 work turn: the boundary-policy→command
// mapping, the completion-artifact resolver (read from the def's declared artifact, NOT a hard-coded loop
// name), the completion marker the prompt instructs and the checker reads (one definition, so writer↔reader
// cannot desync), and the work-prompt composer. No fs, no engine — asserted purely from the outside.

// An artifact binding as the def parser composes it: the confined absolute path and the repo-relative form
// of that same location, which the parser derives from one segment list (loopDefV2 `confineArtifact`).
function artifactOf(leaf: string): { path: string; rel: string } {
  return { path: `/abs/repo/.agent-terminal/loop/artifacts/${leaf}`, rel: `.agent-terminal/loop/artifacts/${leaf}` };
}

function binding(id: string, leaf: string): { id: string; path: string; rel: string } {
  return { id, ...artifactOf(leaf) };
}

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
    pickup: { initialStatus: 'planning', branchTemplate: 'plan-loop/issue-{issue}', initialLabels: [], wipe: { mode: 'abort' } },
    inputs: [],
    outputs: [binding('plan', 'plan.md')],
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
    expect(completionArtifact(d)).toEqual(artifactOf('plan.md'));
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
        binding('diff', 'diff.md'),
        binding('plan', 'plan.md'),
      ],
    });
    expect(completionArtifact(d)).toEqual(artifactOf('plan.md'));
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

describe('resolveChainedInputs (§27.10 — declared inputs partitioned by what the upstream loop left)', () => {
  const twoInputs = () => def({ inputs: [binding('plan', 'plan.md'), binding('notes', 'notes.md')] });

  it('carries {id, rel} for each produced input, in declaration order', () => {
    expect(resolveChainedInputs(twoInputs().inputs, () => 'produced').carried).toEqual([
      { id: 'plan', rel: '.agent-terminal/loop/artifacts/plan.md' },
      { id: 'notes', rel: '.agent-terminal/loop/artifacts/notes.md' },
    ]);
  });

  it('partitions per-element: a produced input carries while its declared sibling does not', () => {
    const r = resolveChainedInputs(twoInputs().inputs, (p) =>
      p === '/abs/repo/.agent-terminal/loop/artifacts/plan.md' ? 'produced' : 'not-produced',
    );
    expect(r.carried).toEqual([{ id: 'plan', rel: '.agent-terminal/loop/artifacts/plan.md' }]);
    expect(r.unresolved).toEqual([{ id: 'notes', state: 'not-produced' }]);
  });

  it('keeps unreadable distinct from not-produced, so the caller can act on the one it can', () => {
    const r = resolveChainedInputs(twoInputs().inputs, (p) =>
      p === '/abs/repo/.agent-terminal/loop/artifacts/plan.md' ? 'unreadable' : 'not-produced',
    );
    expect(r.carried).toEqual([]); // neither is material the work turn can be entered with
    expect(r.unresolved).toEqual([
      { id: 'plan', state: 'unreadable' },
      { id: 'notes', state: 'not-produced' },
    ]);
  });

  it('hands the state predicate the binding\'s absolute path, not its repo-relative form', () => {
    const probed: string[] = [];
    resolveChainedInputs([binding('plan', 'plan.md')], (p: string) => {
      probed.push(p);
      return 'produced';
    });
    expect(probed).toEqual(['/abs/repo/.agent-terminal/loop/artifacts/plan.md']);
  });

  it('carries and declares nothing for a loop with no inputs (the first loop in a chain)', () => {
    const r = resolveChainedInputs([], () => 'produced');
    expect(r).toEqual({ carried: [], unresolved: [] });
  });
});

describe('composeAppWorkPrompt (§27.10 — the carried chained-input block)', () => {
  it('§27.10 — a chained input names each carried artifact id and its repo-relative path', () => {
    const prompt = composeAppWorkPrompt({
      recipeBody: '# work turn\nImplement the plan.',
      turnKey: 'work-implement',
      doneRelPath: '.agent-terminal/loop/turn-done',
      completion: { artifactRel: '.agent-terminal/loop/artifacts/diff.md', marker: completionMarker('implement') },
      inputs: [{ id: 'plan', rel: '.agent-terminal/loop/artifacts/plan.md' }],
    });
    expect(prompt).toContain('Implement the plan.'); // the recipe body still leads
    expect(prompt).toContain('- plan: .agent-terminal/loop/artifacts/plan.md'); // the carried input, id + path
    expect(prompt.toLowerCase()).toContain('declared input');
    // The prompt names where the material came from on disk, never what produced it — the app does not
    // establish that, and the residual is recorded against its own sub-ticket.
    expect(prompt.toLowerCase()).not.toContain('upstream loop');
  });

  it('§27.10 — no chained-input block on a loop entered with no inputs', () => {
    const prompt = composeAppWorkPrompt({
      recipeBody: '# work turn\nGroom the ticket.',
      turnKey: 'work-groom',
      doneRelPath: '.agent-terminal/loop/turn-done',
      completion: { artifactRel: '.agent-terminal/loop/artifacts/groomed-ticket.md', marker: completionMarker('groom') },
      inputs: [],
    });
    expect(prompt.toLowerCase()).not.toContain('declared input');
  });

  it('§27.10 — the chained input survives alongside a redo instruction (recipe → inputs → redo)', () => {
    const prompt = composeAppWorkPrompt({
      recipeBody: '# work turn\nImplement the plan.',
      turnKey: 'work-implement',
      doneRelPath: '.agent-terminal/loop/turn-done',
      completion: null,
      inputs: [{ id: 'plan', rel: '.agent-terminal/loop/artifacts/plan.md' }],
      instruction: 'Keep only the schema section.',
    });
    expect(prompt).toContain('- plan: .agent-terminal/loop/artifacts/plan.md'); // the carried input
    expect(prompt).toContain('Keep only the schema section.'); // the redo instruction
    expect(prompt.indexOf('plan.md')).toBeLessThan(prompt.indexOf('Keep only the schema section.')); // inputs above redo
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
