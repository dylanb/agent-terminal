import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RED_COMPLETION, exampleCapturedOutput, examplePhaseResult, phaseOutputRel } from '../../src/shared/phaseResult';
import { ARTIFACT_CHECK_PASSED, runArtifactCheck, type ArtifactCheck, type ArtifactCheckInputs } from '../../src/main/artifactCheck';
import { exampleRoundReport } from '../../src/shared/roundReport';
import { exampleConsolidatorOutput } from '../../src/shared/consolidatorOutput';
import { exampleGoalProgress } from '../../src/shared/goalProgress';
import { verdictOutput } from '../helpers/consolidatorOutputs';
import { checkerArgvOf as argvOf } from '../helpers/artifactCheckArgv';
import { DECISION_FILE_MAX_BYTES, DECISION_NOTE_MAX, decisionProblemText } from '../../src/shared/flowBranch';

// §27.12 — the agent-runnable checker: the command the prompt hands the agent, parsed back by the checker, runs
// the same predicates the engine gates on. Asserted end to end through the argv the command line carries.

const SECTIONS = ['summary', 'findings', 'disposition'];
const ROSTER = ['impl-review-tests', 'impl-review-intent'];
const REPORT: ArtifactCheck = { kind: 'report', rel: '.agent-terminal/loop/reports/1.json', sections: SECTIONS, roster: ROSTER };
const VERDICT: ArtifactCheck = { kind: 'verdict', rel: '.agent-terminal/loop/consolidate/1.json', catalog: ROSTER };

const files = (map: Record<string, string>): ArtifactCheckInputs => ({
  read: (rel) => map[rel] ?? null,
  loadCapabilities: () => ({ ok: false, cause: 'absent', reason: 'no loop-capabilities.yaml in the repository' }),
});

describe('runArtifactCheck — the agent-runnable format check (§27.12)', () => {
  it('passes a well-formed report and a well-formed verdict', () => {
    const r = runArtifactCheck(argvOf(REPORT), files({ [REPORT.rel]: exampleRoundReport({ sections: SECTIONS, roster: ROSTER }) }));
    expect(r).toMatchObject({ exitCode: 0 });
    expect(r.output).toContain(ARTIFACT_CHECK_PASSED);
    const v = runArtifactCheck(argvOf(VERDICT), files({ [VERDICT.rel]: exampleConsolidatorOutput('another round', ROSTER) }));
    expect(v.exitCode).toBe(0);
  });

  it('fails a report missing a reviewer record, naming that record', () => {
    const r = runArtifactCheck(argvOf(REPORT), files({ [REPORT.rel]: exampleRoundReport({ sections: SECTIONS, roster: [ROSTER[0]] }) }));
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain(`no record for ${ROSTER[1]}`);
    expect(r.output).not.toContain(ARTIFACT_CHECK_PASSED);
  });

  it('fails a verdict naming a persona outside the catalog, by position', () => {
    const r = runArtifactCheck(argvOf(VERDICT), files({ [VERDICT.rel]: verdictOutput('another round', { roster: ['ghost'] }) }));
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('"roster"[0] is not in this loop\'s reviewer catalog');
    expect(r.output).not.toContain('ghost');
  });

  it('passes a goal progress file that ends this leg, and fails one that does not, saying why', () => {
    const PROGRESS: ArtifactCheck = { kind: 'progress', rel: '.agent-terminal/loop/goal-progress.0badc0de.json', leg: 2, legs: true };
    const ok = runArtifactCheck(argvOf(PROGRESS), files({ [PROGRESS.rel]: exampleGoalProgress(2, 'checkpoint') }));
    expect(ok.exitCode).toBe(0);
    expect(ok.output).toContain(ARTIFACT_CHECK_PASSED);
    const stale = runArtifactCheck(argvOf(PROGRESS), files({ [PROGRESS.rel]: exampleGoalProgress(1, 'done') }));
    expect(stale.exitCode).toBe(1);
    expect(stale.output).toContain('not this leg (2)');
    const broken = runArtifactCheck(argvOf(PROGRESS), files({ [PROGRESS.rel]: '{"leg": 2, "status": "done",}' }));
    expect(broken.exitCode).toBe(1);
    expect(broken.output).toContain('not valid JSON');
    const oneLeg = runArtifactCheck(argvOf({ ...PROGRESS, legs: false }), files({ [PROGRESS.rel]: exampleGoalProgress(2, 'checkpoint') }));
    expect(oneLeg.exitCode).toBe(1);
  });

  it('passes a phase result with the outcome its phase needs and a captured run, and fails one that does not, saying why', () => {
    const RESULT: ArtifactCheck = { kind: 'result', rel: '.agent-terminal/loop/artifacts/green-result.json', outcome: 'passed', build: 'built' };
    const run = { [phaseOutputRel(RESULT.rel)]: exampleCapturedOutput('passed') };
    const ok = runArtifactCheck(argvOf(RESULT), files({ [RESULT.rel]: examplePhaseResult('passed', { build: 'built' }), ...run }));
    expect(ok.exitCode).toBe(0);
    expect(ok.output).toContain(ARTIFACT_CHECK_PASSED);
    const failing = runArtifactCheck(argvOf(RESULT), files({ [RESULT.rel]: examplePhaseResult('failed-assertion', { build: 'built' }), ...run }));
    expect(failing.exitCode).toBe(1);
    expect(failing.output).toContain('reports failed-assertion, not passed');
    const unbuilt = runArtifactCheck(argvOf(RESULT), files({ [RESULT.rel]: examplePhaseResult('passed'), ...run }));
    expect(unbuilt.output).toContain('reports no build, not built');
    const noRun = runArtifactCheck(argvOf(RESULT), files({ [RESULT.rel]: examplePhaseResult('passed', { build: 'built' }) }));
    expect(noRun.exitCode).toBe(1);
    expect(noRun.output).toContain(`${phaseOutputRel(RESULT.rel)} is missing`);
    const red: ArtifactCheck = { kind: 'result', rel: '.agent-terminal/loop/artifacts/red-result.json', outcome: 'failed-assertion' };
    const redRun = { [phaseOutputRel(red.rel)]: exampleCapturedOutput('failed-assertion') };
    expect(runArtifactCheck(argvOf(red), files({ [red.rel]: examplePhaseResult('failed-assertion'), ...redRun })).exitCode).toBe(0);
    expect(runArtifactCheck(argvOf(red), files({ [red.rel]: 'outcome: failed-assertion\n', ...redRun })).output).toContain('not valid JSON');
  });

  it("passes RED's check for a verification-only result, and still fails a passing run that claims nothing", () => {
    const red: ArtifactCheck = { kind: 'result', rel: '.agent-terminal/loop/artifacts/red-result.json', ...RED_COMPLETION };
    const run = { [phaseOutputRel(red.rel)]: exampleCapturedOutput('passed') };
    expect(runArtifactCheck(argvOf(red), files({ [red.rel]: examplePhaseResult('passed', { verificationOnly: true }), ...run })).exitCode).toBe(0);
    expect(runArtifactCheck(argvOf(red), files({ [red.rel]: examplePhaseResult('failed-assertion'), ...run })).exitCode).toBe(0);
    const unclaimed = runArtifactCheck(argvOf(red), files({ [red.rel]: examplePhaseResult('passed'), ...run }));
    expect(unclaimed.exitCode).toBe(1);
    expect(unclaimed.output).toContain('reports passed, not failed-assertion');
  });

  describe('a decision file, read the way the approve reads it', () => {
    let dir: string;
    let decision: Extract<ArtifactCheck, { kind: 'decision' }>;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'artifact-check-decision-'));
      decision = { kind: 'decision', rel: join(dir, 'verdict.json'), values: ['bug', 'not-a-bug'] };
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('passes a decision file holding a declared value', () => {
      writeFileSync(decision.rel, '{"decision":"not-a-bug","note":"feature request"}');
      const r = runArtifactCheck(argvOf(decision), files({}));
      expect(r).toEqual({ exitCode: 0, output: expect.stringContaining(ARTIFACT_CHECK_PASSED) });
    });

    it.each([
      ['missing', null],
      ['too-large', JSON.stringify({ decision: 'bug', pad: 'x'.repeat(DECISION_FILE_MAX_BYTES) })],
      ['not-json', 'decision: bug'],
      ['no-decision-field', '{"verdict":"bug"}'],
      ['undeclared-value', '{"decision":"Bug"}'],
      ['note-too-long', JSON.stringify({ decision: 'bug', note: 'x'.repeat(DECISION_NOTE_MAX + 1) })],
    ] as const)('fails a decision file that is %s, saying so in the words the gate shows', (problem, content) => {
      if (content !== null) writeFileSync(decision.rel, content);
      const r = runArtifactCheck(argvOf(decision), files({}));
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain(decisionProblemText(problem));
    });

    it('fails a decision path that is a symlink or a directory as unreadable, as the approve refuses it', () => {
      const target = join(dir, 'elsewhere.json');
      writeFileSync(target, '{"decision":"bug"}');
      symlinkSync(target, decision.rel);
      const linked = runArtifactCheck(argvOf(decision), files({}));
      expect(linked.exitCode).toBe(1);
      expect(linked.output).toContain(decisionProblemText('unreadable'));
      rmSync(decision.rel);
      mkdirSync(decision.rel);
      const folder = runArtifactCheck(argvOf(decision), files({}));
      expect(folder.exitCode).toBe(1);
      expect(folder.output).toContain(decisionProblemText('unreadable'));
    });
  });

  it('fails a missing file, naming it', () => {
    const r = runArtifactCheck(argvOf(REPORT), files({}));
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain(REPORT.rel);
  });

  it('rejects argv it does not understand as a usage error', () => {
    expect(runArtifactCheck(['nonsense'], files({})).exitCode).toBe(2);
  });

  it('rejects the capabilities check given an operand as a usage error, even when the capabilities pass', () => {
    const passing: ArtifactCheckInputs = {
      read: () => null,
      loadCapabilities: () => ({ ok: true, value: { testGlobs: ['tests/**'], testCommand: 'npm test', buildCommand: 'npm run build' } }),
    };
    expect(runArtifactCheck(['capabilities', 'extra'], passing).exitCode).toBe(2);
  });

  it('quotes an operand carrying shell metacharacters so it reaches the checker verbatim (CWE-78)', () => {
    const hostile: ArtifactCheck = { kind: 'verdict', rel: 'a;b$(x).md', catalog: ROSTER };
    expect(argvOf(hostile)[1]).toBe('a;b$(x).md');
  });
});
