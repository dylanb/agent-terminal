import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APP_LOOP_STATE_SCHEMA,
  armInterrupt,
  clearInterrupt,
  enterPolish,
  clearPolish,
  isPolishActiveForStep,
  consolidatorOutputFile,
  consolidatorOutputRel,
  parseAppLoopState,
  readAppLoopState,
  readArmedInterrupt,
  roundReportFile,
  roundReportRel,
  serializeAppLoopState,
  writeAppLoopState,
  writeAppLoopBootstrap,
  readAppLoopBootstrap,
  type AppLoopBootstrap,
  type AppLoopRunState,
} from '../../src/main/appLoopState';

// §27.10/§27.12 — the app-owned §27 loop-state file under <repo>/.agent-terminal/loop/, carrying a
// version/schema discriminator (mirroring §26's versioned state.yaml) so a later slice can migrate or
// reject an older resume file deterministically. Real temp files, no fs mocks. The writer is NEW in this
// slice, so its destination is confined and its FIRST-RUN test removes the target root before asserting the
// tree is created (CLAUDE.md first-run-writer rule).

const RUN: AppLoopRunState = { loop: 'plan-loop', step: 'plan', turnKey: 'work-plan', status: 'working' };
const FIXED = (): Date => new Date('2026-07-17T12:00:00.000Z');

let repo: string;
const loopDir = (): string => join(repo, '.agent-terminal', 'loop');
const stateFile = (): string => join(loopDir(), 'run-state.yaml');
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'apploop-'));
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('§27 loop-state serialize/parse round-trip', () => {
  it('round-trips a working run and carries the schema discriminator', () => {
    const text = serializeAppLoopState(RUN, FIXED);
    expect(text).toContain(`schema_version: ${APP_LOOP_STATE_SCHEMA}`);
    const back = parseAppLoopState(text);
    expect(back).toEqual(RUN);
  });

  it('round-trips an errored run with its reason', () => {
    const errored: AppLoopRunState = { ...RUN, status: 'error', errorReason: 'stalled: no terminal activity' };
    expect(parseAppLoopState(serializeAppLoopState(errored, FIXED))).toEqual(errored);
  });

  it('round-trips the terminal accepted status a §27 gate approve writes (N5)', () => {
    // §27.9/§27.13 / N5 — approve writes a terminal `accepted` run-state (no verdict), so a relaunch
    // reconstructs a benign non-gate view and a raced second approve is inert.
    const accepted: AppLoopRunState = { loop: 'plan-loop', step: 'plan', turnKey: 'consolidate-plan', status: 'accepted' };
    const back = parseAppLoopState(serializeAppLoopState(accepted, FIXED));
    expect(back).toEqual(accepted);
    expect(back?.status).toBe('accepted');
  });

  it('drops the error reason on a non-error status (writer↔reader agree on the gate)', () => {
    // The reason belongs only to `error`; a `working`/`complete` run carries none, so a stale reason can
    // never render on a recovered status.
    const withReason: AppLoopRunState = { ...RUN, status: 'complete', errorReason: 'stale' };
    const back = parseAppLoopState(serializeAppLoopState(withReason, FIXED));
    expect(back).toEqual({ loop: 'plan-loop', step: 'plan', turnKey: 'work-plan', status: 'complete' });
    expect(back?.errorReason).toBeUndefined();
  });

  it('rejects a differently-versioned file rather than mis-parsing it (deterministic version gate)', () => {
    const text = serializeAppLoopState(RUN, FIXED).replace(
      `schema_version: ${APP_LOOP_STATE_SCHEMA}`,
      `schema_version: ${APP_LOOP_STATE_SCHEMA + 1}`,
    );
    expect(parseAppLoopState(text)).toBeNull();
  });

  it('returns null for a malformed document rather than throwing', () => {
    expect(parseAppLoopState('name: [unterminated')).toBeNull();
    expect(parseAppLoopState('42')).toBeNull();
  });

  it('rejects an out-of-vocabulary status rather than surfacing a value the view/route-out cannot handle', () => {
    // A plausible-but-illegal status (e.g. 'running', 'stopped') must parse to null, not leak past the
    // STATUSES gate — the view and route-out only understand working/error/complete.
    const text = serializeAppLoopState(RUN, FIXED).replace('status: working', 'status: running');
    expect(parseAppLoopState(text)).toBeNull();
  });
});

describe('§27 loop-state writer — confined, first-run, atomic, no .gitignore', () => {
  it('creates the .agent-terminal/loop tree on first run (target root absent) and reads it back', () => {
    // First-run: the fixture mkdtemp'd only the repo; neither .agent-terminal nor loop exists. The writer
    // must create the whole tree, or it ships a jail that only works when the anchor already exists.
    expect(existsSync(join(repo, '.agent-terminal'))).toBe(false);
    writeAppLoopState(repo, RUN, FIXED);
    expect(existsSync(stateFile())).toBe(true);
    expect(readAppLoopState(repo)).toEqual(RUN);
  });

  it('never writes a .gitignore (§19.1/§25 no-gitignore rule)', () => {
    writeAppLoopState(repo, RUN, FIXED);
    expect(existsSync(join(loopDir(), '.gitignore'))).toBe(false);
    expect(existsSync(join(repo, '.agent-terminal', '.gitignore'))).toBe(false);
    expect(existsSync(join(repo, '.gitignore'))).toBe(false);
  });

  it('overwrites a prior run-state atomically (whole-document, last write wins)', () => {
    writeAppLoopState(repo, RUN, FIXED);
    const errored: AppLoopRunState = { ...RUN, status: 'error', errorReason: 'no hosted agent at the prompt' };
    writeAppLoopState(repo, errored, FIXED);
    expect(readAppLoopState(repo)).toEqual(errored);
  });

  it('readAppLoopState returns null when no run-state file is present', () => {
    expect(readAppLoopState(repo)).toBeNull();
  });

  it('refuses to write through a symlinked loop container rather than following it (CWE-59)', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'apploop-evil-'));
    try {
      symlinkSync(elsewhere, join(repo, '.agent-terminal')); // a planted link where the app dir should be
      expect(() => writeAppLoopState(repo, RUN, FIXED)).toThrow();
      expect(existsSync(join(elsewhere, 'loop', 'run-state.yaml'))).toBe(false);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe('§27 bootstrap-identity file — disjoint from the run-state document (ST2 AC8)', () => {
  // §27.10 — the pr/branch/issue a bootstrap opens is set once and read many times over later turns; its
  // lifecycle is independent of the per-turn run-state doc, so it lives in its OWN file (the polish/armed-
  // interrupt own-file pattern) — a wholesale run-state write can neither clobber nor resurrect it.
  const IDENTITY: AppLoopBootstrap = {
    pr: 87,
    branch: 'plan-loop/issue-78',
    issue: 78,
  };
  const bootstrapFile = (): string => join(loopDir(), 'bootstrap.yaml');

  it('round-trips pr/branch/issue through its own file, created first-run (target root absent)', () => {
    expect(existsSync(join(repo, '.agent-terminal'))).toBe(false);
    writeAppLoopBootstrap(repo, IDENTITY, FIXED);
    expect(existsSync(bootstrapFile())).toBe(true);
    expect(readAppLoopBootstrap(repo)).toEqual(IDENTITY);
  });

  it('is byte-for-byte untouched by a wholesale run-state write, and vice versa (disjoint files)', () => {
    writeAppLoopBootstrap(repo, IDENTITY, FIXED);
    const bootstrapBytes = readFileSync(bootstrapFile(), 'utf8');
    // A full run-state document write must not perturb the bootstrap-identity file.
    writeAppLoopState(repo, { ...RUN, status: 'error', errorReason: 'boom' }, FIXED);
    expect(readFileSync(bootstrapFile(), 'utf8')).toBe(bootstrapBytes);
    expect(readAppLoopBootstrap(repo)).toEqual(IDENTITY);
    // And re-writing the bootstrap identity must not perturb the run-state document.
    writeAppLoopState(repo, RUN, FIXED);
    const runBytes = readFileSync(stateFile(), 'utf8');
    writeAppLoopBootstrap(repo, { ...IDENTITY, pr: 99 }, FIXED);
    expect(readFileSync(stateFile(), 'utf8')).toBe(runBytes);
  });

  it('never writes a .gitignore (§19.1/§25 no-gitignore rule)', () => {
    writeAppLoopBootstrap(repo, IDENTITY, FIXED);
    expect(existsSync(join(loopDir(), '.gitignore'))).toBe(false);
    expect(existsSync(join(repo, '.agent-terminal', '.gitignore'))).toBe(false);
    expect(existsSync(join(repo, '.gitignore'))).toBe(false);
  });

  it('leaves a pre-existing .gitignore byte-for-byte unchanged', () => {
    const gitignore = join(repo, '.gitignore');
    const before = '# operator-owned\n.agent-terminal/\n';
    writeFileSync(gitignore, before);

    writeAppLoopBootstrap(repo, IDENTITY, FIXED);

    expect(readFileSync(gitignore, 'utf8')).toBe(before);
  });

  it('returns null when absent, and drops a field-invalid file rather than surfacing a phantom identity', () => {
    expect(readAppLoopBootstrap(repo)).toBeNull();
    writeAppLoopBootstrap(repo, IDENTITY, FIXED);
    // A non-integer / negative pr or issue, or blank branch, is not a valid identity (CWE-20).
    for (const bad of [
      'pr: -1',
      'pr: 1.5',
      'pr: 9007199254740992',
      'issue: 0',
      'branch: ""',
    ]) {
      const good = readFileSync(bootstrapFile(), 'utf8');
      const field = bad.split(':')[0];
      const mutated = good.replace(new RegExp(`^${field}:.*$`, 'm'), bad);
      writeFileSync(bootstrapFile(), mutated);
      expect(readAppLoopBootstrap(repo), bad).toBeNull();
    }
  });

  it('refuses a field-invalid identity on write instead of persisting an unreadable bootstrap file', () => {
    expect(() => writeAppLoopBootstrap(repo, { ...IDENTITY, pr: 0 }, FIXED)).toThrow(/invalid/i);
    expect(existsSync(bootstrapFile())).toBe(false);
  });

  it('refuses to write through a symlinked loop container rather than following it (CWE-59)', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'apploop-boot-evil-'));
    try {
      symlinkSync(elsewhere, join(repo, '.agent-terminal'));
      expect(() => writeAppLoopBootstrap(repo, IDENTITY, FIXED)).toThrow();
      expect(existsSync(join(elsewhere, 'loop', 'bootstrap.yaml'))).toBe(false);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe('§27 loop-state resume reconstruction', () => {
  it('reconstructs the stopped turn (loop + step + turnKey + status) after a simulated relaunch', () => {
    const errored: AppLoopRunState = { ...RUN, status: 'error', errorReason: 'stalled: no terminal activity' };
    writeAppLoopState(repo, errored, FIXED);
    // Relaunch = a fresh read against the same repo dir; the run reconstructs which turn stopped.
    expect(readAppLoopState(repo)).toEqual(errored);
  });
});

// §27.12/AC9 — a review-and-fix turn persists its round number so a relaunch reconstructs the stopped
// review turn AND knows which round it was. The round is absent through the work turn (no round has run).
describe('§27 loop-state — the review turn round number', () => {
  const REVIEW: AppLoopRunState = { loop: 'plan-loop', step: 'plan', turnKey: 'review-plan', status: 'working', round: 1 };

  it('round-trips a review run carrying its round number', () => {
    const text = serializeAppLoopState(REVIEW, FIXED);
    expect(text).toContain('round: 1');
    expect(parseAppLoopState(text)).toEqual(REVIEW);
  });

  it('round-trips an errored review run carrying both its round and reason', () => {
    const errored: AppLoopRunState = { ...REVIEW, status: 'error', errorReason: 'report omits a roster persona' };
    expect(parseAppLoopState(serializeAppLoopState(errored, FIXED))).toEqual(errored);
  });

  it('carries no round for a work run (absent = no round has run)', () => {
    const text = serializeAppLoopState(RUN, FIXED);
    expect(text).not.toContain('round:');
    expect(parseAppLoopState(text)?.round).toBeUndefined();
  });

  it('drops a non-positive or non-integer round rather than surfacing a fabricated identity (field-local validation)', () => {
    for (const bad of ['0', '-1', '1.5', 'two']) {
      const text = serializeAppLoopState(REVIEW, FIXED).replace('round: 1', `round: ${bad}`);
      expect(parseAppLoopState(text)?.round).toBeUndefined();
    }
  });

  it('drops a non-positive or non-integer round on the WRITE side too (one gate governs serialize and parse)', () => {
    for (const bad of [0, -1, 1.5]) {
      expect(serializeAppLoopState({ ...REVIEW, round: bad }, FIXED)).not.toContain('round:');
    }
  });
});

// §27.9/§19.4 / N5 (AC4) — a review round entered by a request-changes decision carries the operator's
// feedback, persisted so a relaunch mid-round reconstructs it and a Retry re-injects it rather than silently
// dropping the human's input. Absent on a consolidator-driven another-round; a blank value is not persisted.
describe('§27 loop-state — the request-changes feedback for a review round', () => {
  const REVIEW_FB: AppLoopRunState = {
    loop: 'plan-loop',
    step: 'plan',
    turnKey: 'review-plan',
    status: 'working',
    round: 2,
    feedback: 'Tighten the migration section; it overspecifies the schema.',
  };

  it('round-trips a review run carrying the operator feedback', () => {
    const back = parseAppLoopState(serializeAppLoopState(REVIEW_FB, FIXED));
    expect(back).toEqual(REVIEW_FB);
    expect(back?.feedback).toBe('Tighten the migration section; it overspecifies the schema.');
  });

  it('carries no feedback for a work or consolidator-driven review run (absent = none)', () => {
    const text = serializeAppLoopState({ loop: 'plan-loop', step: 'plan', turnKey: 'review-plan', status: 'working', round: 3 }, FIXED);
    expect(text).not.toContain('feedback:');
    expect(parseAppLoopState(text)?.feedback).toBeUndefined();
  });

  it('drops a blank/whitespace-only or non-string feedback rather than persisting an empty block (field-local)', () => {
    for (const bad of ['', '   ']) {
      expect(serializeAppLoopState({ ...REVIEW_FB, feedback: bad }, FIXED)).not.toContain('feedback:');
    }
    // a non-string value that reached disk (hand-edited) parses back as no feedback
    const text = serializeAppLoopState(REVIEW_FB, FIXED).replace(/feedback:.*/, 'feedback: 42');
    expect(parseAppLoopState(text)?.feedback).toBeUndefined();
  });

  it('survives a write→read round-trip on disk (relaunch reconstructs the feedback)', () => {
    writeAppLoopState(repo, REVIEW_FB, FIXED);
    expect(readAppLoopState(repo)?.feedback).toBe('Tighten the migration section; it overspecifies the schema.');
  });
});

// §27.9/AC5 — a redo re-enters the WORK turn carrying the human's instruction; it is persisted on the work
// run-state (mirroring the review feedback) so a relaunch mid-work reconstructs it and a Retry re-injects it
// rather than dropping the instruction. Absent on an ordinary work run; a blank value is not persisted.
describe('§27 loop-state — the redo instruction for a work run', () => {
  const WORK_REDO: AppLoopRunState = {
    loop: 'plan-loop',
    step: 'plan',
    turnKey: 'work-plan',
    status: 'working',
    instruction: 'Start over; the plan structure is wrong. Keep only the schema section.',
  };

  it('round-trips a work run carrying the redo instruction', () => {
    const back = parseAppLoopState(serializeAppLoopState(WORK_REDO, FIXED));
    expect(back).toEqual(WORK_REDO);
    expect(back?.instruction).toBe('Start over; the plan structure is wrong. Keep only the schema section.');
  });

  it('carries no instruction for an ordinary work run (absent = none)', () => {
    const text = serializeAppLoopState({ loop: 'plan-loop', step: 'plan', turnKey: 'work-plan', status: 'working' }, FIXED);
    expect(text).not.toContain('instruction:');
    expect(parseAppLoopState(text)?.instruction).toBeUndefined();
  });

  it('drops a blank/whitespace-only or non-string instruction rather than persisting an empty block (field-local)', () => {
    for (const bad of ['', '   ']) {
      expect(serializeAppLoopState({ ...WORK_REDO, instruction: bad }, FIXED)).not.toContain('instruction:');
    }
    const text = serializeAppLoopState(WORK_REDO, FIXED).replace(/instruction:.*/, 'instruction: 42');
    expect(parseAppLoopState(text)?.instruction).toBeUndefined();
  });

  it('survives a write→read round-trip on disk (relaunch reconstructs the instruction)', () => {
    writeAppLoopState(repo, WORK_REDO, FIXED);
    expect(readAppLoopState(repo)?.instruction).toBe('Start over; the plan structure is wrong. Keep only the schema section.');
  });
});

// §27.10 — the binding ids this step's entry decided to carry, persisted so a redo or a relaunch honours that
// decision rather than re-deriving one from whatever is on disk. Absent means carried nothing, so a malformed
// value must fail toward NOT carrying rather than toward carrying everything declared.
describe('§27 loop-state — the chained-input carry for a work run', () => {
  const WORK_CHAINED: AppLoopRunState = {
    loop: 'plan-loop',
    step: 'plan',
    turnKey: 'work-plan',
    status: 'working',
    chainedInputs: ['groomed-ticket', 'design-notes'],
  };

  it('round-trips the carried binding ids in declaration order', () => {
    const back = parseAppLoopState(serializeAppLoopState(WORK_CHAINED, FIXED));
    expect(back).toEqual(WORK_CHAINED);
    expect(back?.chainedInputs).toEqual(['groomed-ticket', 'design-notes']);
  });

  it('carries no field for a run that chained nothing (absent = carried nothing)', () => {
    const text = serializeAppLoopState({ loop: 'plan-loop', step: 'plan', turnKey: 'work-plan', status: 'working' }, FIXED);
    expect(text).not.toContain('chained_inputs:');
    expect(parseAppLoopState(text)?.chainedInputs).toBeUndefined();
  });

  it('reads a malformed carry as carried nothing while every sibling field survives (field-local)', () => {
    for (const bad of ['chained_inputs: groomed-ticket', 'chained_inputs:\n  - ok\n  - bad: 1', 'chained_inputs: []']) {
      const text = serializeAppLoopState(WORK_CHAINED, FIXED).replace(/chained_inputs:\n(  - .*\n)+/, `${bad}\n`);
      const back = parseAppLoopState(text);
      expect(back?.chainedInputs).toBeUndefined();
      expect(back?.step).toBe('plan'); // the rest of the document is unaffected
      expect(back?.status).toBe('working');
    }
  });

  it('survives a write→read round-trip on disk (relaunch reconstructs the carry)', () => {
    writeAppLoopState(repo, WORK_CHAINED, FIXED);
    expect(readAppLoopState(repo)?.chainedInputs).toEqual(['groomed-ticket', 'design-notes']);
  });
});

// §27.5/AC7 — the round report's write-target (the fixer, via roundReportRel) and read-source (the engine,
// via roundReportFile) derive from ONE resolver so they cannot drift (CLAUDE.md writer↔reader-location). The
// location is round-keyed and disjoint from the engine's own run-state file, confined to the untrusted repo
// tree (resolveJail). The pin runs first-run: the fixture mkdtemp'd only the repo, so the reports tree is
// absent — a resolver that only works when the anchor already exists would fail here.
describe('§27 round-report location resolver', () => {
  it('resolves round N to <repo>/.agent-terminal/loop/reports/<N>.md, write-target === read-source', () => {
    expect(existsSync(join(repo, '.agent-terminal'))).toBe(false); // first run: the tree is absent
    expect(roundReportRel(1)).toBe('.agent-terminal/loop/reports/1.md');
    expect(roundReportFile(repo, 1)).toBe(join(realpathSync(repo), roundReportRel(1)));
    expect(roundReportFile(repo, 2)).toBe(join(realpathSync(repo), roundReportRel(2)));
  });

  it('keeps distinct rounds at disjoint locations, and disjoint from the run-state file', () => {
    expect(roundReportFile(repo, 1)).not.toBe(roundReportFile(repo, 2));
    expect(roundReportFile(repo, 1)).not.toBe(stateFile());
  });

  it('refuses a report location behind a symlinked loop container rather than following it (CWE-59)', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'apploop-evil-report-'));
    try {
      symlinkSync(elsewhere, join(repo, '.agent-terminal'));
      expect(roundReportFile(repo, 1)).toBeNull();
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

// §27.6/AC3 — the consolidator's output has a write-target (the actor, via consolidatorOutputRel) and a
// read-source (the completion gate, via consolidatorOutputFile) that derive from ONE resolver, round-keyed
// and disjoint from the round reports (writer↔reader-location).
describe('§27 consolidator-output location resolver', () => {
  it('resolves round N to <repo>/.agent-terminal/loop/consolidate/<N>.md, write-target === read-source', () => {
    expect(consolidatorOutputRel(2)).toBe('.agent-terminal/loop/consolidate/2.md');
    expect(consolidatorOutputFile(repo, 2)).toBe(join(realpathSync(repo), consolidatorOutputRel(2)));
  });

  it('keeps consolidator output disjoint from the round report of the same round', () => {
    expect(consolidatorOutputFile(repo, 1)).not.toBe(roundReportFile(repo, 1));
  });

  it('refuses a consolidator-output location behind a symlinked loop container (CWE-59)', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'apploop-evil-consol-'));
    try {
      symlinkSync(elsewhere, join(repo, '.agent-terminal'));
      expect(consolidatorOutputFile(repo, 1)).toBeNull();
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

// §27.6/AC5 — a consolidator run persists its verdict, and (through the single-sourced gate) its reason
// ONLY under `stop for a human`, plus the roster it chose (AC8). Additive to the run-state document.
describe('§27 loop-state — the consolidator verdict / reason / chosen roster', () => {
  const CONSOL: AppLoopRunState = {
    loop: 'plan-loop',
    step: 'plan',
    turnKey: 'consolidate-plan',
    status: 'complete',
    round: 2,
    verdict: 'another round',
    chosenRoster: ['review-plan-principal', 'review-plan-security'],
  };

  it('round-trips a consolidator run carrying its verdict and chosen roster', () => {
    const text = serializeAppLoopState(CONSOL, FIXED);
    expect(text).toContain('verdict: another round');
    expect(parseAppLoopState(text)).toEqual(CONSOL);
  });

  it('round-trips a stop-for-a-human verdict carrying its reason', () => {
    const stop: AppLoopRunState = { ...CONSOL, verdict: 'stop for a human', chosenRoster: undefined, verdictReason: 'reviewers disagree on the API shape' };
    expect(parseAppLoopState(serializeAppLoopState(stop, FIXED))).toEqual(stop);
  });

  it('drops the verdict reason on any verdict other than stop-for-a-human (reason iff stop-for-a-human gate)', () => {
    const withReason: AppLoopRunState = { ...CONSOL, verdict: 'another round', verdictReason: 'stale' };
    const back = parseAppLoopState(serializeAppLoopState(withReason, FIXED));
    expect(back?.verdictReason).toBeUndefined();
    expect(back?.verdict).toBe('another round');
  });

  it('rejects an out-of-set verdict rather than surfacing a value the branch cannot handle', () => {
    const text = serializeAppLoopState(CONSOL, FIXED).replace('verdict: another round', 'verdict: looks-fine');
    expect(parseAppLoopState(text)?.verdict).toBeUndefined();
  });
});

// §27.9/AC9/AC11 — the armed-interrupt flag is persisted INDEPENDENTLY of the wholesale run-state write, so
// a turn-status persist can neither clobber an arm nor resurrect a cleared one, and it survives a relaunch.
describe('§27 armed-interrupt — persisted independently of the run-state document', () => {
  it('reads back the armed step after a simulated relaunch (null before any arm)', () => {
    expect(readArmedInterrupt(repo)).toBeNull();
    armInterrupt(repo, 'plan');
    expect(readArmedInterrupt(repo)).toEqual({ step: 'plan' });
  });

  it('a wholesale run-state write does NOT clobber an armed interrupt (clobber regression)', () => {
    armInterrupt(repo, 'plan');
    writeAppLoopState(repo, { ...RUN, turnKey: 'consolidate-plan', status: 'working', round: 2 }, FIXED);
    expect(readArmedInterrupt(repo)).toEqual({ step: 'plan' });
  });

  it('a wholesale run-state write does NOT resurrect a cleared interrupt', () => {
    armInterrupt(repo, 'plan');
    clearInterrupt(repo);
    expect(readArmedInterrupt(repo)).toBeNull();
    writeAppLoopState(repo, RUN, FIXED);
    expect(readArmedInterrupt(repo)).toBeNull();
  });

  it('validates the persisted armed step on read — an empty/missing step is not armed (CWE-20)', () => {
    armInterrupt(repo, 'plan');
    clearInterrupt(repo);
    // arming with a blank step is inert — never a phantom arm on an empty identity
    armInterrupt(repo, '');
    expect(readArmedInterrupt(repo)).toBeNull();
  });

  it('refuses to arm behind a symlinked loop container rather than following it (CWE-59)', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'apploop-evil-arm-'));
    try {
      symlinkSync(elsewhere, join(repo, '.agent-terminal'));
      expect(() => armInterrupt(repo, 'plan')).toThrow();
      expect(existsSync(join(elsewhere, 'loop', 'armed-interrupt.yaml'))).toBe(false);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

// §27.9/AC6/AC11 — the polish stand-down is app-owned loop state persisted in its OWN file, disjoint from the
// run-state document, so a turn-status write can neither clobber an active stand-down nor resurrect a cleared
// one, and it survives a relaunch (the orchestrator still stands down) until the operator approves.
describe('§27 polish stand-down — persisted independently of the run-state document', () => {
  it('is active for the polish step after a simulated relaunch (inactive before any polish)', () => {
    expect(isPolishActiveForStep(repo, 'plan')).toBe(false);
    enterPolish(repo, 'plan');
    expect(isPolishActiveForStep(repo, 'plan')).toBe(true);
  });

  it('a wholesale run-state write does NOT clobber an active polish stand-down (AC11 clobber regression)', () => {
    enterPolish(repo, 'plan');
    writeAppLoopState(repo, { ...RUN, turnKey: 'consolidate-plan', status: 'complete', round: 2 }, FIXED);
    expect(isPolishActiveForStep(repo, 'plan')).toBe(true);
  });

  it('a wholesale run-state write does NOT resurrect a cleared polish stand-down', () => {
    enterPolish(repo, 'plan');
    clearPolish(repo);
    expect(isPolishActiveForStep(repo, 'plan')).toBe(false);
    writeAppLoopState(repo, RUN, FIXED);
    expect(isPolishActiveForStep(repo, 'plan')).toBe(false);
  });

  it('validates the persisted polish step on read — an empty/missing step is not a stand-down (CWE-20)', () => {
    enterPolish(repo, 'plan');
    clearPolish(repo);
    enterPolish(repo, ''); // a blank step is inert — never a phantom stand-down on an empty identity
    expect(isPolishActiveForStep(repo, '')).toBe(false);
  });

  it('refuses to enter polish behind a symlinked loop container rather than following it (CWE-59)', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'apploop-evil-polish-'));
    try {
      symlinkSync(elsewhere, join(repo, '.agent-terminal'));
      expect(() => enterPolish(repo, 'plan')).toThrow();
      expect(existsSync(join(elsewhere, 'loop', 'polish.yaml'))).toBe(false);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  // §27.9/AC6 — the ONE stand-down-identity predicate both the engine's lever-suppression seam and the view's
  // `inPolish` derive from, so they cannot drift on which step is standing down (CLAUDE.md shared-semantics).
  it('isPolishActiveForStep is true only for the standing-down step (single-sourced identity)', () => {
    expect(isPolishActiveForStep(repo, 'plan')).toBe(false); // none active
    enterPolish(repo, 'plan');
    expect(isPolishActiveForStep(repo, 'plan')).toBe(true); // active for this step
    expect(isPolishActiveForStep(repo, 'implement')).toBe(false); // not for another step
    clearPolish(repo);
    expect(isPolishActiveForStep(repo, 'plan')).toBe(false); // cleared
  });
});

// §27.9/AC6/AC9/AC11 — the polish stand-down and the armed interrupt are TWO independent flags. They share a
// serialized shape but are disjoint state: writing or clearing one never surfaces as, clobbers, or resurrects
// the other. (The disjointness a common single-flag primitive must preserve — a shared writer that collapsed
// the two onto one file would pass every per-flag test above yet fail here.)
describe('§27 polish stand-down and armed interrupt — disjoint flags', () => {
  it('arming an interrupt is not a polish stand-down, and clearing one never touches the other', () => {
    armInterrupt(repo, 'plan');
    expect(isPolishActiveForStep(repo, 'plan')).toBe(false); // an armed interrupt never reads back as an active polish

    enterPolish(repo, 'implement');
    expect(readArmedInterrupt(repo)).toEqual({ step: 'plan' }); // the arm is untouched by entering polish
    expect(isPolishActiveForStep(repo, 'implement')).toBe(true);

    clearPolish(repo);
    expect(readArmedInterrupt(repo)).toEqual({ step: 'plan' }); // clearing polish does not clear the interrupt
    expect(isPolishActiveForStep(repo, 'implement')).toBe(false);

    clearInterrupt(repo);
    expect(readArmedInterrupt(repo)).toBeNull();
  });
});
