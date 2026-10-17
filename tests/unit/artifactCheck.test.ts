import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { ARTIFACT_CHECK_PASSED, artifactCheckCommand, runArtifactCheck, type ArtifactCheck } from '../../src/main/artifactCheck';
import { exampleRoundReport } from '../../src/shared/roundReport';
import { exampleConsolidatorOutput } from '../../src/shared/consolidatorOutput';
import { exampleGoalProgress } from '../../src/shared/goalProgress';

// §27.12 — the agent-runnable checker: the command the prompt hands the agent, parsed back by the checker, runs
// the same predicates the engine gates on. Asserted end to end through the argv the command line carries.

const SECTIONS = ['summary', 'findings', 'disposition'];
const ROSTER = ['impl-review-tests', 'impl-review-intent'];
const REPORT: ArtifactCheck = { kind: 'report', rel: '.agent-terminal/loop/reports/1.json', sections: SECTIONS, roster: ROSTER };
const VERDICT: ArtifactCheck = { kind: 'verdict', rel: '.agent-terminal/loop/consolidate/1.md', catalog: ROSTER };

/** The argv a POSIX shell hands the checker script for `command` (everything after the script operand). */
function argvOf(check: ArtifactCheck): string[] {
  const command = artifactCheckCommand({ execPath: '/bin/echo', script: 'SCRIPT' }, check);
  const printed = execFileSync('/bin/sh', ['-c', `${command.replace(/^ELECTRON_RUN_AS_NODE=1 /, '')} | tr ' ' '\\n'`], { encoding: 'utf8' });
  return printed.trim().split('\n').slice(1);
}

const files = (map: Record<string, string>) => (rel: string): string | null => map[rel] ?? null;

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

  it('fails a verdict naming a persona outside the catalog', () => {
    const r = runArtifactCheck(argvOf(VERDICT), files({ [VERDICT.rel]: 'verdict: another round\nroster: ghost\n' }));
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('ghost');
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

  it('fails a missing file, naming it', () => {
    const r = runArtifactCheck(argvOf(REPORT), files({}));
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain(REPORT.rel);
  });

  it('rejects argv it does not understand as a usage error', () => {
    expect(runArtifactCheck(['nonsense'], files({})).exitCode).toBe(2);
  });

  it('quotes an operand carrying shell metacharacters so it reaches the checker verbatim (CWE-78)', () => {
    const hostile: ArtifactCheck = { kind: 'verdict', rel: 'a;b$(x).md', catalog: ROSTER };
    expect(argvOf(hostile)[1]).toBe('a;b$(x).md');
  });
});
