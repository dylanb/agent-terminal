import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearSliceBrief,
  readSliceBrief,
  writeSliceBrief,
  APP_LOOP_STATE_SCHEMA,
  armInterrupt,
  clearAppLoopBootstrap,
  clearInterrupt,
  enterPolish,
  clearPolish,
  isPolishActiveForStep,
  consolidatorOutputFile,
  consolidatorOutputRel,
  refactorResultFile,
  refactorResultRel,
  parseAppLoopState,
  readAppLoopState,
  readArmedInterrupt,
  roundReportFile,
  roundReportRel,
  serializeAppLoopState,
  writeAppLoopState,
  writeAppLoopBootstrap,
  writeAppLoopBootstrapIntent,
  readAppLoopBootstrap,
  readPickupRecord,
  recordBaselineCommit,
  readBaselineCommit,
  clearBaselineCommit,
  recordChangedTests,
  readChangedTests,
  MAX_CHANGED_TEST_PATHS,
  MAX_CHANGED_TEST_PATH_LEN,
  type AppLoopBootstrap,
  type AppLoopRunState,
  type ChangedTestsRecord,
} from '../../src/main/appLoopState';

// §27.10/§27.12 — the app-owned §27 loop-state file under <repo>/.agent-terminal/loop/, carrying a
// version/schema discriminator (like a versioned state.yaml) so a later slice can migrate or
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
    initialStatus: 'planning',
  };
  const bootstrapFile = (): string => join(loopDir(), 'bootstrap.yaml');

  it('round-trips pr/branch/issue through its own file, created first-run (target root absent)', () => {
    expect(existsSync(join(repo, '.agent-terminal'))).toBe(false);
    writeAppLoopBootstrap(repo, IDENTITY, FIXED);
    expect(existsSync(bootstrapFile())).toBe(true);
    expect(readAppLoopBootstrap(repo)).toEqual(IDENTITY);
  });

  it.each(['grooming', 'planning', 'implementing'])(
    'preserves the def-declared initial status %s',
    (initialStatus) => {
      writeAppLoopBootstrap(repo, { ...IDENTITY, initialStatus }, FIXED);
      expect(readAppLoopBootstrap(repo)?.initialStatus).toBe(initialStatus);
    },
  );

  it('reads the additive v1 completed shape written before initial_status existed', () => {
    mkdirSync(loopDir(), { recursive: true });
    writeFileSync(
      bootstrapFile(),
      'schema_version: 1\npr: 87\nbranch: plan-loop/issue-78\nissue: 78\n',
    );

    expect(readAppLoopBootstrap(repo)).toEqual({
      pr: 87,
      branch: 'plan-loop/issue-78',
      issue: 78,
    });
  });

  it('clears only the completed bootstrap journal after owned compensation', () => {
    writeAppLoopBootstrap(repo, IDENTITY, FIXED);
    writeAppLoopState(repo, RUN, FIXED);

    clearAppLoopBootstrap(repo);

    expect(existsSync(bootstrapFile())).toBe(false);
    expect(readAppLoopState(repo)).toEqual(expect.objectContaining(RUN));
  });

  it('journals intent before outward mutation without surfacing a completed identity', () => {
    writeAppLoopBootstrapIntent(
      repo,
      {
        branch: IDENTITY.branch,
        issue: IDENTITY.issue,
        initialStatus: IDENTITY.initialStatus,
      },
      FIXED,
    );
    expect(readFileSync(bootstrapFile(), 'utf8')).toContain('status: pending');
    expect(readFileSync(bootstrapFile(), 'utf8')).toContain('initial_status: planning');
    expect(readAppLoopBootstrap(repo)).toBeNull();

    writeAppLoopBootstrap(repo, IDENTITY, FIXED);
    expect(readFileSync(bootstrapFile(), 'utf8')).toContain('status: complete');
    expect(readAppLoopBootstrap(repo)).toEqual(IDENTITY);
  });

  it('refuses a planted bootstrap directory before a journal can be written', () => {
    mkdirSync(bootstrapFile(), { recursive: true });
    expect(() =>
      writeAppLoopBootstrapIntent(
        repo,
        {
          branch: IDENTITY.branch,
          issue: IDENTITY.issue,
          initialStatus: IDENTITY.initialStatus,
        },
        FIXED,
      ),
    ).toThrow();
  });

  it('refuses a bootstrap leaf symlink without writing or deleting its target', () => {
    mkdirSync(loopDir(), { recursive: true });
    const target = join(loopDir(), 'artifacts', 'operator-owned.md');
    mkdirSync(join(loopDir(), 'artifacts'), { recursive: true });
    writeFileSync(target, 'operator owned\n');
    symlinkSync(target, bootstrapFile());

    expect(() =>
      writeAppLoopBootstrapIntent(
        repo,
        {
          branch: IDENTITY.branch,
          issue: IDENTITY.issue,
          initialStatus: IDENTITY.initialStatus,
        },
        FIXED,
      ),
    ).toThrow();
    expect(() => clearAppLoopBootstrap(repo)).toThrow();
    expect(readFileSync(target, 'utf8')).toBe('operator owned\n');
    expect(readAppLoopBootstrap(repo)).toBeNull();
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
    const good = readFileSync(bootstrapFile(), 'utf8');
    // A non-integer / negative pr or issue, or blank branch, is not a valid identity (CWE-20).
    for (const bad of [
      'pr: -1',
      'pr: 1.5',
      'pr: 9007199254740992',
      'issue: 0',
      'branch: ""',
      'initial_status: ""',
    ]) {
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

  it('tells an absent or pending pickup record apart from a completed one', () => {
    expect(readPickupRecord(repo)).toEqual({ kind: 'none' });
    writeAppLoopBootstrapIntent(repo, { branch: IDENTITY.branch, issue: IDENTITY.issue, initialStatus: IDENTITY.initialStatus }, FIXED);
    expect(readPickupRecord(repo)).toEqual({ kind: 'pending' });
    writeAppLoopBootstrap(repo, IDENTITY, FIXED);
    expect(readPickupRecord(repo)).toEqual({ kind: 'complete', bootstrap: IDENTITY });
  });

  it('reports a malformed, field-invalid, or non-file pickup record as invalid, naming the file', () => {
    mkdirSync(loopDir(), { recursive: true });
    for (const text of ['pr: [unclosed', '- just a list', 'schema_version: 99\nstatus: complete\npr: 1\nbranch: b\nissue: 1\n', 'schema_version: 1\nstatus: complete\npr: -1\nbranch: b\nissue: 1\n', 'schema_version: 1\nstatus: pending\nbranch: b\ninitial_status: planning\n', 'schema_version: 1\nstatus: pending\nbranch: ""\nissue: 1\ninitial_status: planning\n']) {
      writeFileSync(bootstrapFile(), text);
      const record = readPickupRecord(repo);
      expect(record.kind, text).toBe('invalid');
      expect(record.kind === 'invalid' && record.detail, text).toContain('bootstrap.yaml');
    }
    rmSync(bootstrapFile());
    mkdirSync(bootstrapFile());
    expect(readPickupRecord(repo).kind).toBe('invalid');
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

// §28.5.3/S5 — a REFACTOR round's phase-result file has a write-target (the fixer, via refactorResultRel) and a
// read-source (the round gate, via refactorResultFile) from ONE resolver, round-keyed and disjoint from the
// round reports and the consolidator output (writer↔reader-location). Confined to the untrusted repo tree.
describe('§28 refactor-result location resolver', () => {
  it('resolves round N to <repo>/.agent-terminal/loop/refactor-results/<N>.md, write-target === read-source', () => {
    expect(existsSync(join(repo, '.agent-terminal'))).toBe(false); // first run: the tree is absent
    expect(refactorResultRel(1)).toBe('.agent-terminal/loop/refactor-results/1.md');
    expect(refactorResultFile(repo, 1)).toBe(join(realpathSync(repo), refactorResultRel(1)));
    expect(refactorResultFile(repo, 2)).toBe(join(realpathSync(repo), refactorResultRel(2)));
  });

  it('keeps the refactor result disjoint from the round report AND the consolidator output of the same round', () => {
    expect(refactorResultFile(repo, 1)).not.toBe(roundReportFile(repo, 1));
    expect(refactorResultFile(repo, 1)).not.toBe(consolidatorOutputFile(repo, 1));
  });

  it('refuses a refactor-result location behind a symlinked loop container (CWE-59)', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'apploop-evil-refac-'));
    try {
      symlinkSync(elsewhere, join(repo, '.agent-terminal'));
      expect(refactorResultFile(repo, 1)).toBeNull();
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

describe('§28.4/§28.5.1 — the baseline-commit store, disjoint from the run-state document', () => {
  // §28.4 phase-as-a-loop rewrites run-state.yaml wholesale between RED/GREEN/refactor, so the phase-commit
  // baseline (set on RED approve, read by the next phase's frozen check) lives in its OWN file — a wholesale
  // run-state write can neither clobber nor resurrect it (the polish/armed-interrupt own-file pattern).
  const baselineFile = (): string => join(loopDir(), 'baseline-commit.yaml');
  const OID = 'a'.repeat(40);

  it('UT-STATE-1: round-trips { branch, sha }', () => {
    recordBaselineCommit(repo, 'feature-slice1', OID);
    expect(readBaselineCommit(repo)).toEqual({ branch: 'feature-slice1', sha: OID });
  });

  // The two CWE-20 guards (write-side + read-side re-validation) are pinned SEPARATELY so neither masks the
  // other (CLAUDE.md two-non-redundant-places). 2a isolates the write-side by checking NO file is written; 2b
  // isolates the read-side by PLANTING a bad file the write-side never saw.
  it('UT-STATE-2a (write-side CWE-20): a non-object-id sha or blank branch writes NO file', () => {
    for (const badSha of ['too-short', 'z'.repeat(40), '   ', `${OID}extra`, '../../etc/passwd']) {
      rmSync(baselineFile(), { force: true });
      recordBaselineCommit(repo, 'feature-slice1', badSha);
      expect(existsSync(baselineFile())).toBe(false); // nothing persisted — the write-side guard fired
    }
    rmSync(baselineFile(), { force: true });
    recordBaselineCommit(repo, '', OID); // a blank branch is inert
    expect(existsSync(baselineFile())).toBe(false);
  });

  it('UT-STATE-2c (detached sentinel): the literal HEAD branch is inert — a detached-HEAD commit records no matchable baseline', () => {
    // §28.5.1 single-sources the detached sentinel: currentGitBranch (the read) maps a detached HEAD to null, so
    // the write must likewise refuse the raw 'HEAD' that rev-parse --abbrev-ref yields when detached — else a
    // persisted { branch: 'HEAD' } would stay unmatchable only by the reader's grace (two copies of one rule).
    rmSync(baselineFile(), { force: true });
    recordBaselineCommit(repo, 'HEAD', OID);
    expect(existsSync(baselineFile())).toBe(false);
    expect(readBaselineCommit(repo)).toBeNull();
  });

  // §27.9.1 N9b.7(c) — #137 S4 "Baseline as persisted": the caller observes whether a baseline now exists.
  it('UT-STATE-persisted: returns the baseline it persisted, and null when it persisted none', () => {
    expect(recordBaselineCommit(repo, 'feature-slice1', OID)).toEqual({ branch: 'feature-slice1', sha: OID });
    expect(recordBaselineCommit(repo, 'HEAD', OID)).toBeNull();
    expect(recordBaselineCommit(repo, '', OID)).toBeNull();
    expect(recordBaselineCommit(repo, 'feature-slice1', 'not-a-sha')).toBeNull();
  });

  it('UT-STATE-persisted (failed write): a write that cannot land persists no baseline, whether it throws or returns null', () => {
    rmSync(baselineFile(), { force: true });
    mkdirSync(baselineFile(), { recursive: true });
    let returned: unknown = 'threw';
    try {
      returned = recordBaselineCommit(repo, 'feature-slice1', OID);
    } catch {
      // the fail-loud contract is one of the two allowed outcomes
    }
    expect([null, 'threw']).toContain(returned);
    expect(readBaselineCommit(repo)).toBeNull();
  });

  it('UT-STATE-2b (read-side CWE-20): a PLANTED baseline with a bad sha or blank branch reads unset', () => {
    mkdirSync(loopDir(), { recursive: true });
    for (const bad of [
      `schema_version: 1\nbranch: main\nsha: not-a-sha\n`,
      `schema_version: 1\nbranch: main\nsha: ${'z'.repeat(40)}\n`,
      `schema_version: 1\nbranch: ''\nsha: ${OID}\n`,
      `not-a-mapping\n`, // isRecord guard
    ]) {
      writeFileSync(baselineFile(), bad);
      expect(readBaselineCommit(repo)).toBeNull(); // the read-side re-validation fired (no write-side masking)
    }
  });

  it('UT-STATE-clear (#123): clearBaselineCommit removes the baseline so a stale prior-slice baseline reads unset', () => {
    recordBaselineCommit(repo, 'feature-slice1', OID);
    expect(readBaselineCommit(repo)).not.toBeNull();
    clearBaselineCommit(repo);
    expect(readBaselineCommit(repo)).toBeNull();
    expect(existsSync(baselineFile())).toBe(false);
  });

  it('UT-STATE-clear-absent: clearBaselineCommit on a repo with no baseline is a silent no-op', () => {
    rmSync(baselineFile(), { force: true });
    expect(() => clearBaselineCommit(repo)).not.toThrow();
    expect(readBaselineCommit(repo)).toBeNull();
  });

  it('UT-STATE-first-run: records into a repo with NO .agent-terminal yet, creating the tree', () => {
    expect(existsSync(join(repo, '.agent-terminal'))).toBe(false); // fresh machine — nothing seeded
    recordBaselineCommit(repo, 'feature-slice1', OID);
    expect(existsSync(baselineFile())).toBe(true);
    expect(readBaselineCommit(repo)).toEqual({ branch: 'feature-slice1', sha: OID });
  });

  it('UT-STATE-overwrite: a second record replaces the first (single current baseline, last-write-wins)', () => {
    recordBaselineCommit(repo, 'feature-slice1', OID);
    recordBaselineCommit(repo, 'feature-slice2', 'b'.repeat(40));
    expect(readBaselineCommit(repo)).toEqual({ branch: 'feature-slice2', sha: 'b'.repeat(40) });
  });

  it('UT-STATE-3: an absent baseline file reads as unset (null), not an error', () => {
    expect(readBaselineCommit(repo)).toBeNull();
  });

  it('UT-STATE-4: neither wholesale write clobbers the other (the disjoint-file rule, RED-first pins)', () => {
    recordBaselineCommit(repo, 'feature-slice1', OID);
    const baselineBytes = readFileSync(baselineFile(), 'utf8');
    writeAppLoopState(repo, RUN, FIXED); // a wholesale run-state write...
    expect(readFileSync(baselineFile(), 'utf8')).toBe(baselineBytes); // ...leaves the baseline byte-for-byte untouched
    expect(readBaselineCommit(repo)).toEqual({ branch: 'feature-slice1', sha: OID });

    const stateBytes = readFileSync(stateFile(), 'utf8');
    recordBaselineCommit(repo, 'feature-slice2', 'b'.repeat(40)); // ...and recording a baseline
    expect(readFileSync(stateFile(), 'utf8')).toBe(stateBytes); // ...leaves run-state byte-for-byte unchanged
  });

  it('UT-STATE-5: a wrong schema_version reads unset', () => {
    mkdirSync(loopDir(), { recursive: true });
    writeFileSync(baselineFile(), `schema_version: 999\nbranch: feature-slice1\nsha: ${OID}\n`);
    expect(readBaselineCommit(repo)).toBeNull();
  });

  it('UT-STATE-5b: refuses to write through a symlinked loop container (CWE-59)', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'apploop-evil-'));
    try {
      symlinkSync(elsewhere, join(repo, '.agent-terminal'));
      expect(() => recordBaselineCommit(repo, 'feature-slice1', OID)).toThrow();
      expect(existsSync(join(elsewhere, 'loop', 'baseline-commit.yaml'))).toBe(false);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe('§28.5.3 — the changed-tests flag store, disjoint from the run-state document', () => {
  // §28.8.3 detect-and-escalate: at GREEN completion the engine records WHICH test-glob files changed since the
  // RED baseline as a NON-blocking flag the regression-guard persona + human gate read. App-owned machine state
  // whose lifecycle is independent of the run-state document lives in its OWN file (the polish/armed-interrupt/
  // baseline pattern), so a wholesale run-state write cannot clobber or resurrect it.
  const changedFile = (): string => join(loopDir(), 'changed-tests.yaml');

  it('CT-1: round-trips { step, paths }', () => {
    recordChangedTests(repo, 'green-slice1', ['tests/a.test.ts', 'tests/b.test.ts']);
    const rec: ChangedTestsRecord | null = readChangedTests(repo);
    expect(rec).toEqual({ step: 'green-slice1', paths: ['tests/a.test.ts', 'tests/b.test.ts'] });
  });

  it('CT-2: an empty paths list records an explicit empty record (checked-none, distinct from unset)', () => {
    recordChangedTests(repo, 'green-slice1', []);
    expect(readChangedTests(repo)).toEqual({ step: 'green-slice1', paths: [] });
    // …distinct from "never recorded" (which reads null):
  });

  it('CT-3: an absent file reads as unset (null), not an error', () => {
    expect(readChangedTests(repo)).toBeNull();
  });

  it('CT-4 (write-side): a blank step writes NO file (inert)', () => {
    rmSync(changedFile(), { force: true });
    recordChangedTests(repo, '', ['tests/a.test.ts']);
    expect(existsSync(changedFile())).toBe(false);
  });

  it('CT-5 (write-side per-entry filtering): non-string/blank/over-length path entries are dropped, valid kept', () => {
    // a blank and an over-length entry are dropped; the valid siblings are kept, sorted+deduped:
    const tooLong = 'tests/' + 'x'.repeat(MAX_CHANGED_TEST_PATH_LEN) + '.test.ts';
    recordChangedTests(repo, 'green-slice1', ['tests/b.test.ts', '', '   ', tooLong, 'tests/a.test.ts', 'tests/a.test.ts']);
    expect(readChangedTests(repo)).toEqual({ step: 'green-slice1', paths: ['tests/a.test.ts', 'tests/b.test.ts'] });
  });

  it('CT-6 (write-side count cap): at most MAX_CHANGED_TEST_PATHS entries are kept', () => {
    const many = Array.from({ length: MAX_CHANGED_TEST_PATHS + 50 }, (_, i) => `tests/f${String(i).padStart(6, '0')}.test.ts`);
    recordChangedTests(repo, 'green-slice1', many);
    const rec = readChangedTests(repo);
    expect(rec?.paths.length).toBe(MAX_CHANGED_TEST_PATHS);
  });

  it('CT-7 (read-side CWE-20): a PLANTED file with a bad shape reads unset (null)', () => {
    mkdirSync(loopDir(), { recursive: true });
    for (const bad of [
      `not-a-mapping\n`, // isRecord guard
      `schema_version: 999\nstep: green\npaths: []\n`, // wrong schema
      `schema_version: 1\nstep: ''\npaths: []\n`, // blank step
      `schema_version: 1\nstep: green\npaths: not-an-array\n`, // paths not an array
    ]) {
      writeFileSync(changedFile(), bad);
      expect(readChangedTests(repo)).toBeNull();
    }
  });

  it('CT-8 (read-side per-entry filtering): a planted file with garbage entries filters them out, keeps valid', () => {
    mkdirSync(loopDir(), { recursive: true });
    // a planted array mixing a valid path, a number, an object, a blank — only the valid string survives:
    writeFileSync(changedFile(), `schema_version: 1\nstep: green\npaths:\n  - tests/ok.test.ts\n  - 42\n  - ''\n  - {a: 1}\n`);
    expect(readChangedTests(repo)).toEqual({ step: 'green', paths: ['tests/ok.test.ts'] });
  });

  // CT-8b (read-side CWE-400/CWE-20, pinned SEPARATELY from the write-side CT-5/CT-6 so neither masks the other,
  // mirroring baseline-commit's UT-STATE-2a/2b): a PLANTED file (bypassing the writer) whose paths exceed the
  // count cap and include an over-length entry is re-bounded on READ — the reader independently re-enforces the
  // caps, since the hosted agent can write this file directly and its paths reach the DOM.
  it('CT-8b (read-side cap re-enforcement): a planted oversized / over-length file is capped on read', () => {
    mkdirSync(loopDir(), { recursive: true });
    const many = Array.from({ length: MAX_CHANGED_TEST_PATHS + 50 }, (_, i) => `tests/f${String(i).padStart(6, '0')}.test.ts`);
    const overLong = 'tests/' + 'x'.repeat(MAX_CHANGED_TEST_PATH_LEN) + '.test.ts';
    const paths = [overLong, ...many]; // plain scalars — safe as an unquoted yaml list
    writeFileSync(changedFile(), `schema_version: 1\nstep: green\npaths:\n${paths.map((p) => `  - ${p}`).join('\n')}\n`);
    const rec = readChangedTests(repo);
    expect(rec?.paths.length).toBe(MAX_CHANGED_TEST_PATHS); // count cap re-enforced on read
    expect(rec?.paths).not.toContain(overLong); // over-length entry dropped on read
  });

  it('CT-9 first-run: records into a repo with NO .agent-terminal yet, creating the tree', () => {
    expect(existsSync(join(repo, '.agent-terminal'))).toBe(false); // fresh machine — nothing seeded
    recordChangedTests(repo, 'green-slice1', ['tests/a.test.ts']);
    expect(existsSync(changedFile())).toBe(true);
    expect(readChangedTests(repo)).toEqual({ step: 'green-slice1', paths: ['tests/a.test.ts'] });
  });

  it('CT-10 overwrite: a second record replaces the first (single current flag)', () => {
    recordChangedTests(repo, 'green-slice1', ['tests/a.test.ts']);
    recordChangedTests(repo, 'green-slice2', []);
    expect(readChangedTests(repo)).toEqual({ step: 'green-slice2', paths: [] });
  });

  it('CT-11: neither wholesale write clobbers the other (disjoint-file rule, RED-first pins)', () => {
    recordChangedTests(repo, 'green-slice1', ['tests/a.test.ts']);
    const flagBytes = readFileSync(changedFile(), 'utf8');
    writeAppLoopState(repo, RUN, FIXED); // a wholesale run-state write...
    expect(readFileSync(changedFile(), 'utf8')).toBe(flagBytes); // ...leaves the flag byte-for-byte untouched
    expect(readChangedTests(repo)).toEqual({ step: 'green-slice1', paths: ['tests/a.test.ts'] });

    const stateBytes = readFileSync(stateFile(), 'utf8');
    recordChangedTests(repo, 'green-slice2', ['tests/c.test.ts']); // ...and recording the flag
    expect(readFileSync(stateFile(), 'utf8')).toBe(stateBytes); // ...leaves run-state byte-for-byte unchanged
  });

  it('CT-12: refuses to write through a symlinked loop container (CWE-59)', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'apploop-ct-evil-'));
    try {
      symlinkSync(elsewhere, join(repo, '.agent-terminal'));
      expect(() => recordChangedTests(repo, 'green-slice1', ['tests/a.test.ts'])).toThrow();
      expect(existsSync(join(elsewhere, 'loop', 'changed-tests.yaml'))).toBe(false);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

// §28.4.2 — the back-to-RED slice brief is app-owned loop state in its OWN file, disjoint from the run-state
// document: the RED/GREEN/refactor phases rewrite run-state wholesale while the brief must outlive all three.
describe('§28.4.2 slice brief — persisted independently of the run-state document', () => {
  const BRIEF = { slice: 2, fromStep: 'green', text: 'Cover the empty-input case the tests missed' };

  it('reads back what was written, and nothing after it is cleared', () => {
    expect(readSliceBrief(repo)).toBeNull();
    writeSliceBrief(repo, BRIEF);
    expect(readSliceBrief(repo)).toEqual(BRIEF);
    clearSliceBrief(repo);
    expect(readSliceBrief(repo)).toBeNull();
  });

  it('a wholesale run-state write neither clobbers an active brief nor resurrects a cleared one', () => {
    writeSliceBrief(repo, BRIEF);
    writeAppLoopState(repo, { ...RUN, turnKey: 'consolidate-plan', status: 'complete', round: 2 }, FIXED);
    expect(readSliceBrief(repo)).toEqual(BRIEF);
    clearSliceBrief(repo);
    writeAppLoopState(repo, RUN, FIXED);
    expect(readSliceBrief(repo)).toBeNull();
  });

  it('writing the brief leaves the run-state document byte-for-byte unchanged', () => {
    writeAppLoopState(repo, RUN, FIXED);
    const runState = readFileSync(join(repo, '.agent-terminal', 'loop', 'run-state.yaml'), 'utf8');
    writeSliceBrief(repo, BRIEF);
    clearSliceBrief(repo);
    expect(readFileSync(join(repo, '.agent-terminal', 'loop', 'run-state.yaml'), 'utf8')).toBe(runState);
  });

  it('reads a malformed brief as none (CWE-20): a non-positive slice, a blank text, or a blank source step', () => {
    for (const bad of [{ ...BRIEF, slice: 0 }, { ...BRIEF, slice: 1.5 }, { ...BRIEF, text: '  ' }, { ...BRIEF, fromStep: '' }]) {
      writeSliceBrief(repo, bad);
      expect(readSliceBrief(repo), JSON.stringify(bad)).toBeNull();
    }
  });

  it('refuses to write behind a symlinked loop container rather than following it (CWE-59)', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'apploop-evil-brief-'));
    try {
      symlinkSync(elsewhere, join(repo, '.agent-terminal'));
      expect(() => writeSliceBrief(repo, BRIEF)).toThrow();
      expect(existsSync(join(elsewhere, 'loop', 'slice-brief.yaml'))).toBe(false);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
