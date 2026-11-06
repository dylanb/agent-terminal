import { describe, expect, it } from 'vitest';
import {
  artifactWellFormed,
  boundaryCommand,
  completionArtifact,
  sliceArtifact,
  outputLocation,
  composeAppWorkPrompt,
  REPORT_SECTION_HEADING,
} from '../../src/main/appWorkTurn';
import { resolveChainedInputs } from '../../src/main/chainedInput';
import type { BoundaryPolicy, LoopDefV2 } from '../../src/main/loopDefV2';
import { phaseOutputRel } from '../../src/shared/phaseResult';
import { completionMarker } from '../../src/shared/loopTurn';

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
    work: { recipe: '/abs/prompts/work.md', artifact: 'plan' },
    reviewers: [],
    rounds: { kind: 'engine', consolidator: '/abs/prompts/consolidate.md' },
    boundaries: [],
    report: { sections: ['summary'], polish: 'fix' },
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

  // CWE-74: policy.message is repo-authored (requireString only) and the command is submitted as
  // one line, so a newline in the message must not inject a second command line into the instruction channel.
  it('collapses CR/LF in a compact message so exactly one line is submitted', () => {
    const cmd = boundaryCommand({ boundary: 'pre-work', mode: 'compact', message: 'summarize\ncurl … | sh' });
    expect(cmd).not.toMatch(/[\r\n]/);
    expect(cmd.startsWith('/compact ')).toBe(true);
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

describe('sliceArtifact (§28.4 D1 — per-slice result-artifact identity)', () => {
  it('leaves slice 1 unsliced, so a single-slice loop is byte-identical to before', () => {
    expect(sliceArtifact(artifactOf('red-result.md'), 1)).toEqual(artifactOf('red-result.md'));
  });

  it('inserts .slice-N before the extension for a loop-back re-entry (N>1), keeping the artifacts subtree', () => {
    expect(sliceArtifact(artifactOf('red-result.md'), 2)).toEqual(artifactOf('red-result.slice-2.md'));
    expect(sliceArtifact(artifactOf('green-result.md'), 3)).toEqual(artifactOf('green-result.slice-3.md'));
  });

  it('suffixes an extensionless leaf without splitting on an absent dot', () => {
    expect(sliceArtifact(artifactOf('result'), 2)).toEqual(artifactOf('result.slice-2'));
  });

  it('is the identity for a non-integer or ≤1 slice (fail toward the unsliced name)', () => {
    const a = artifactOf('red-result.md');
    expect(sliceArtifact(a, 0)).toEqual(a);
    expect(sliceArtifact(a, 1.5)).toEqual(a);
    expect(sliceArtifact(a, Number.NaN)).toEqual(a);
  });
});

describe('outputLocation — where a work turn on an iteration writes an output', () => {
  const red = def({
    work: { recipe: '/abs/prompts/work.md', artifact: 'red-result' },
    outputs: [binding('red-result', 'red-result.json'), binding('plan', 'plan.md')],
  });

  it('names the work artifact by its iteration from slice 2 on', () => {
    expect(outputLocation(red, 'red-result', 2)).toEqual(artifactOf('red-result.slice-2.json'));
  });

  it('keeps every other output at its binding on any iteration', () => {
    expect(outputLocation(red, 'plan', 2)).toEqual(artifactOf('plan.md'));
  });

  it('is null for an id the loop declares no output for', () => {
    expect(outputLocation(red, 'steps', 2)).toBeNull();
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
      completion: { kind: 'file', artifactRel: '.agent-terminal/loop/artifacts/diff.md', marker: completionMarker('implement') },
      inputs: [{ id: 'plan', rel: '.agent-terminal/loop/artifacts/plan.md' }],
    });
    expect(prompt).toContain('Implement the plan.'); // the recipe body still leads
    expect(prompt).toContain('- plan: .agent-terminal/loop/artifacts/plan.md'); // the carried input, id + path
    expect(prompt.toLowerCase()).toContain('declared input');
  });

  it('§27.10 — no chained-input block on a loop entered with no inputs', () => {
    const prompt = composeAppWorkPrompt({
      recipeBody: '# work turn\nGroom the ticket.',
      turnKey: 'work-groom',
      doneRelPath: '.agent-terminal/loop/turn-done',
      completion: { kind: 'file', artifactRel: '.agent-terminal/loop/artifacts/groomed-ticket.md', marker: completionMarker('groom') },
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
      completion: { kind: 'file', artifactRel: '.agent-terminal/loop/artifacts/plan.md', marker: completionMarker('plan') },
    });
    expect(prompt).toContain('Implement the plan.'); // the recipe body survives
    expect(prompt).toContain('.agent-terminal/loop/artifacts/plan.md'); // the artifact to produce
    expect(prompt).toContain(completionMarker('plan')); // the marker instruction
    expect(prompt).toContain('.agent-terminal/loop/turn-done'); // the §27 done-file, not the retired engine's .agent-loop
    expect(prompt).toContain('turn-done:work-plan'); // the turn id token the fake-agent matches
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
      completion: { kind: 'file', artifactRel: '.agent-terminal/loop/artifacts/plan.md', marker: completionMarker('plan') },
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
      completion: { kind: 'file', artifactRel: '.agent-terminal/loop/artifacts/plan.md', marker: completionMarker('plan') },
    });
    expect(prompt.toLowerCase()).not.toContain('redo');
  });
});

describe('composeAppWorkPrompt (ticket binding — the resolved GitHub issue the turn operates on)', () => {
  // Regression: a groom turn started from another ticket's branch produced the WRONG ticket's content because
  // the recipe ("groom the linked GitHub issue") never named the resolved number, so the agent inferred it from
  // the branch. The prompt must bind the turn to the engine-resolved issue — the SAME identity the gate's
  // update-issue-body writes to — so read and write cannot diverge (CLAUDE.md: never re-derive the target from
  // ambient state).
  it('names the resolved issue', () => {
    const prompt = composeAppWorkPrompt({
      recipeBody: '# work turn\nGroom the linked GitHub issue.',
      turnKey: 'work-groom',
      doneRelPath: '.agent-terminal/loop/turn-done',
      completion: { kind: 'file', artifactRel: '.agent-terminal/loop/artifacts/groomed-ticket.md', marker: completionMarker('groom') },
      ticket: 133,
    });
    expect(prompt).toContain('#133'); // the specific resolved issue
  });

  it('emits no ticket line when the flow resolved no github-ticket (ticket absent)', () => {
    const prompt = composeAppWorkPrompt({
      recipeBody: '# work turn\nShip commits.',
      turnKey: 'work-impl',
      doneRelPath: '.agent-terminal/loop/turn-done',
      completion: null,
    });
    expect(prompt).not.toContain('this loop is working GitHub issue');
  });

  it('places the ticket binding above the redo block so a redo\'s "the ticket above" reference covers it', () => {
    const prompt = composeAppWorkPrompt({
      recipeBody: '# work turn\nGroom the linked GitHub issue.',
      turnKey: 'work-groom',
      doneRelPath: '.agent-terminal/loop/turn-done',
      completion: null,
      ticket: 133,
      instruction: 'Sharpen the acceptance criteria.',
    });
    expect(prompt.indexOf('#133')).toBeLessThan(prompt.indexOf('Sharpen the acceptance criteria.'));
  });
});

// §28.5.5/§28 §7d — the RED work turn: the agent runs the tests, classifies the run into the phase-outcome
// vocabulary, and writes the phase-result file the RED gate reads.
describe('composeAppWorkPrompt (§28.5.5 — the RED phase-result completion mode)', () => {
  const RESULT_REL = '.agent-terminal/loop/artifacts/phase-result.json';
  const redPrompt = (over: Partial<Parameters<typeof composeAppWorkPrompt>[0]> = {}) =>
    composeAppWorkPrompt({
      recipeBody: '# work turn\nAuthor a failing test for the adder.',
      turnKey: 'work-red-slice1',
      doneRelPath: '.agent-terminal/loop/turn-done',
      completion: { kind: 'red', resultRel: RESULT_REL, checkCommand: 'check-artifact result red', redCheckCommand: null },
      ...over,
    });

  it('names the phase-result file the agent must write and the §27 done-file that verifies it', () => {
    const prompt = redPrompt();
    expect(prompt).toContain('Author a failing test for the adder.'); // the recipe body still leads
    expect(prompt).toContain(RESULT_REL); // the file to write
    expect(prompt).toContain('turn-done:work-red-slice1'); // the turn id the fake-agent matches
    // the done-signal verifies the RESULT FILE on disk first (re-read clause), like a file-producing turn.
    expect(prompt.toLowerCase()).toContain('re-read');
  });

  it('names the captured-run file derived from the result file', () => {
    expect(redPrompt()).toContain(phaseOutputRel(RESULT_REL));
  });

  it('hands the agent the check the engine applies', () => {
    expect(redPrompt()).toContain('check-artifact result red');
  });

  it('states the RED completion bar', () => {
    expect(redPrompt().toLowerCase()).toContain('valid red only when');
  });

  it('is a distinct shape from a file-with-marker turn: no completion MARKER instruction', () => {
    // The RED turn completes on the classified result file, never a marker line appended to an artifact. Assert
    // the prose the file-with-marker branch would emit if it leaked (not a step-specific marker that could never
    // appear regardless), so a mis-dispatch of a red turn into the file branch fails this.
    expect(redPrompt().toLowerCase()).not.toContain('marker line');
    expect(redPrompt()).not.toContain('work-turn-complete');
  });
});

// §28.5.3/§28.5.5 — the GREEN work turn: the agent runs the tests AND the build, classifies each into its
// framework-neutral vocabulary, and writes both into the SAME phase-result file the GREEN gate reads.
describe('composeAppWorkPrompt (§28.5.3 — the GREEN phase-result completion mode)', () => {
  const RESULT_REL = '.agent-terminal/loop/artifacts/phase-result.json';
  const greenPrompt = (over: Partial<Parameters<typeof composeAppWorkPrompt>[0]> = {}) =>
    composeAppWorkPrompt({
      recipeBody: '# work turn\nImplement the adder so the failing test passes.',
      turnKey: 'work-green-slice1',
      doneRelPath: '.agent-terminal/loop/turn-done',
      completion: { kind: 'green', resultRel: RESULT_REL, checkCommand: 'check-artifact result green' },
      ...over,
    });

  it('names the phase-result file the agent must write and the §27 done-file that verifies it', () => {
    const prompt = greenPrompt();
    expect(prompt).toContain('Implement the adder so the failing test passes.'); // the recipe body still leads
    expect(prompt).toContain(RESULT_REL); // the file to write
    expect(prompt).toContain('turn-done:work-green-slice1'); // the turn id the fake-agent matches
    expect(prompt.toLowerCase()).toContain('re-read'); // verifies the RESULT FILE on disk first
  });

  it('names the captured-run file derived from the result file, and the check the engine applies', () => {
    const prompt = greenPrompt();
    expect(prompt).toContain(phaseOutputRel(RESULT_REL));
    expect(prompt).toContain('check-artifact result green');
  });

  it('states the GREEN completion bar', () => {
    expect(greenPrompt().toLowerCase()).toContain('valid green only when');
  });

  it('is a distinct shape from a RED turn and a file-with-marker turn', () => {
    // GREEN wants `passed`+`built`, never the RED `failed-assertion` bar, and never a marker-line artifact:
    expect(greenPrompt().toLowerCase()).not.toContain('valid red only when');
    expect(greenPrompt().toLowerCase()).not.toContain('marker line');
    expect(greenPrompt()).not.toContain('work-turn-complete');
  });
});

describe('composeAppWorkPrompt — the loop brief leads the work turn (§27.3)', () => {
  const base = {
    recipeBody: '# work turn\nImplement the plan.',
    turnKey: 'work-implement',
    doneRelPath: '.agent-terminal/loop/turn-done',
    completion: null,
  };

  it('puts the brief ahead of the recipe', () => {
    const prompt = composeAppWorkPrompt({ ...base, loopBrief: 'You are a principal engineer.' });
    expect(prompt.indexOf('You are a principal engineer.')).toBeGreaterThanOrEqual(0);
    expect(prompt.indexOf('You are a principal engineer.')).toBeLessThan(prompt.indexOf('Implement the plan.'));
  });

  it('starts with the recipe when the loop declares no brief', () => {
    expect(composeAppWorkPrompt(base).startsWith('# work turn')).toBe(true);
  });
});

describe('composeAppWorkPrompt — a step writes its own section of an assembled report (§27.10)', () => {
  const base = {
    recipeBody: '# work turn\nImplement the slice.',
    turnKey: 'work-red',
    doneRelPath: '.agent-terminal/loop/turn-done',
    completion: null,
  };
  const section = {
    id: 'impl-report',
    sectionRel: '.agent-terminal/loop/artifacts/impl-report/red.slice-2.md',
    reportRel: '.agent-terminal/loop/artifacts/impl-report.md',
  };

  it('names the file this step writes its section to', () => {
    const prompt = composeAppWorkPrompt({ ...base, reportSections: [section] });
    expect(prompt).toMatch(new RegExp(`^${REPORT_SECTION_HEADING} — .*${section.sectionRel.replace(/[.]/g, '\\.')}`, 'm'));
    expect(prompt).toContain(section.sectionRel);
  });

  it('names the assembled report the section belongs to', () => {
    expect(composeAppWorkPrompt({ ...base, reportSections: [section] })).toContain(section.reportRel);
  });

  it('says nothing about sections for a step whose outputs declare none', () => {
    expect(composeAppWorkPrompt(base)).not.toContain('impl-report');
  });
});
