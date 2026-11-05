// Every read of a loop artifact, or of a file the artifact viewer opens, refuses a named pipe instead of reading
// it, so a pipe planted in the working tree cannot freeze the main process, and refuses a file past its size
// limit instead of reading all of it.

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_LOOP_ARTIFACT_BYTES, readLoopArtifact, readNamedLoopArtifact } from '../../src/main/appLoopPaths';
import { MAX_FILE_BYTES, readArtifact } from '../../src/main/artifactTree';
import { EPIC_PLAN_MAX_BYTES, readEpicSubTicketsAtGate } from '../../src/main/epicPromotion';
import { runFinalizeAccess } from '../../src/main/finalizeAccess';
import { artifactLocation, type LoopDefV2 } from '../../src/main/loopDefV2';
import { checkRed } from '../../src/main/redCheckGate';
import { readRedTestChanges, recordRedTestChanges, redTestChangesArtifact } from '../../src/main/redTestChanges';
import { APPROVE_OPTION, PROMOTE_KIND } from '../../src/shared/engineCapabilities/loop';
import { exampleEpicPlan } from '../../src/shared/epicPlan';
import { LOOP_CAPABILITIES_FILENAME } from '../../src/shared/loopCapabilities';
import { examplePhaseResult } from '../../src/shared/phaseResult';
import { MAX_RED_CHECK_REPORT_BYTES, redCheckReportRel } from '../../src/shared/redCheck';
import { createFedPipes } from '../helpers/fedPipe';

let repo: string;
const pipes = createFedPipes();

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'artifact-bounded-reads-')));
});

afterEach(async () => {
  await pipes.reap();
  rmSync(repo, { recursive: true, force: true });
});

const artifact = (name: string): { path: string; rel: string } => {
  const located = artifactLocation(repo, name);
  if (located.kind !== 'file') throw new Error(`no artifact location for ${name}`);
  mkdirSync(dirname(located.path), { recursive: true });
  return located;
};

const pastLimit = (limit: number): string => `\n# ${'x'.repeat(limit)}\n`;

describe('a loop artifact read by the engine', () => {
  it('is not read from a named pipe', () => {
    const file = artifact('result.json').path;
    pipes.at(file, '{"outcome":"passed"}');
    expect(readLoopArtifact(file)).toBeNull();
  });

  it('is not read past its size limit', () => {
    const file = artifact('result.json').path;
    writeFileSync(file, 'x'.repeat(MAX_LOOP_ARTIFACT_BYTES + 1));
    expect(readLoopArtifact(file)).toBeNull();
  });

  it('is read when it is a regular file within its limit', () => {
    const file = artifact('result.json').path;
    writeFileSync(file, 'x'.repeat(MAX_LOOP_ARTIFACT_BYTES));
    expect(readLoopArtifact(file)?.length).toBe(MAX_LOOP_ARTIFACT_BYTES);
  });
  it('reads a phase\'s captured run as long as a large test suite prints', () => {
    const file = artifact('result.output.txt').path;
    const run = `${'✓ tests/e2e/some.spec.ts › a test that passed (12ms)\n'.repeat(140_000)}  140000 passed\n`;
    writeFileSync(file, run);
    expect(readLoopArtifact(file)?.length).toBe(run.length);
  });
});

describe('a loop artifact an agent names to the format check', () => {
  it('is not read from a named pipe', () => {
    const file = artifact('report.md').path;
    pipes.at(file, '# report\n');
    expect(readNamedLoopArtifact(file)).toBeNull();
  });

  it('is not read past its size limit', () => {
    const file = artifact('report.md').path;
    writeFileSync(file, 'x'.repeat(MAX_LOOP_ARTIFACT_BYTES + 1));
    expect(readNamedLoopArtifact(file)).toBeNull();
  });

  it('is still read through a link the agent names', () => {
    const target = artifact('report.md').path;
    writeFileSync(target, '# report\n');
    const link = join(repo, 'named-report.md');
    symlinkSync(target, link);
    expect(readNamedLoopArtifact(link)).toBe('# report\n');
  });
});

describe('the RED test change record', () => {
  const recorded = (): string => {
    recordRedTestChanges(repo, { branch: 'feat', step: 'green', slice: 1, paths: ['tests/a.test.ts'] });
    return readFileSync(redTestChangesArtifact(repo), 'utf8');
  };

  it('is not read from a named pipe', () => {
    const content = recorded();
    rmSync(redTestChangesArtifact(repo));
    pipes.at(redTestChangesArtifact(repo), content);
    expect(readRedTestChanges(repo)).toBeNull();
  });

  it('is not read past its size limit', () => {
    recorded();
    appendFileSync(redTestChangesArtifact(repo), pastLimit(MAX_LOOP_ARTIFACT_BYTES));
    expect(readRedTestChanges(repo)).toBeNull();
  });
});

describe('the epic plan read at the approve gate', () => {
  const epicDef = (planPath: string): LoopDefV2 => ({
    gate: [{ option: APPROVE_OPTION, sideEffects: [{ kind: PROMOTE_KIND, args: { artifact: 'plan' } }] }],
    inputs: [],
    outputs: [{ id: 'plan', path: planPath, rel: 'plan.md' }],
  } as unknown as LoopDefV2);

  it('is not read from a named pipe', () => {
    const file = artifact('plan.md').path;
    pipes.at(file, exampleEpicPlan());
    expect(readEpicSubTicketsAtGate(epicDef(file))).toBeNull();
  });

  it('is not read past its size limit', () => {
    const file = artifact('plan.md').path;
    writeFileSync(file, exampleEpicPlan() + pastLimit(EPIC_PLAN_MAX_BYTES));
    expect(readEpicSubTicketsAtGate(epicDef(file))).toBeNull();
  });

  it('is read when it is a regular file', () => {
    const file = artifact('plan.md').path;
    writeFileSync(file, exampleEpicPlan());
    expect(readEpicSubTicketsAtGate(epicDef(file))?.length).toBe(2);
  });
});

describe('the RED check', () => {
  const TEST_FILE = 'tests/a.test.ts';
  const RESULT = 'red-result.json';
  const resultFile = (): string => artifact(RESULT).path;
  const reportFile = (): string => artifact(redCheckReportRel(RESULT)).path;
  const reportText = JSON.stringify({ version: 1, tests: [{ file: TEST_FILE, name: 't', outcome: 'failed-assertion', failures: [{ line: 12, message: 'AssertionError' }] }] });
  const resultText = examplePhaseResult('failed-assertion', { intendedFailures: [{ file: TEST_FILE, line: 12 }] });
  const check = () => checkRed({ repoDir: repo, resultPath: resultFile(), addedTestPaths: [TEST_FILE] });

  beforeEach(() => {
    writeFileSync(join(repo, LOOP_CAPABILITIES_FILENAME), 'test_globs: [tests/**]\ntest_command: t\nbuild_command: b\nred_check_command: node check.mjs\n');
    mkdirSync(join(repo, 'tests'));
    writeFileSync(join(repo, TEST_FILE), 'test');
  });

  it('verifies a regular report and result', () => {
    writeFileSync(reportFile(), reportText);
    writeFileSync(resultFile(), resultText);
    expect(check().kind).toBe('verified');
  });

  it('refuses a report that is a named pipe', () => {
    pipes.at(reportFile(), reportText);
    writeFileSync(resultFile(), resultText);
    expect(check()).toEqual({ kind: 'refused', reason: 'the RED check could not read its inputs: not a regular file' });
  });

  it('refuses a report past its size limit', () => {
    writeFileSync(reportFile(), reportText + ' '.repeat(MAX_RED_CHECK_REPORT_BYTES));
    writeFileSync(resultFile(), resultText);
    expect(check()).toEqual({ kind: 'refused', reason: `the RED check report ${artifact(redCheckReportRel(RESULT)).rel} is too large` });
  });

  it('refuses a phase result that is a named pipe', () => {
    writeFileSync(reportFile(), reportText);
    pipes.at(resultFile(), resultText);
    expect(check()).toEqual({ kind: 'refused', reason: 'the RED check could not read its inputs: not a regular file' });
  });

  it('refuses a phase result past its size limit', () => {
    writeFileSync(reportFile(), reportText);
    writeFileSync(resultFile(), resultText + ' '.repeat(MAX_LOOP_ARTIFACT_BYTES));
    expect(check()).toEqual({ kind: 'refused', reason: `the RED result ${RESULT} is too large` });
  });

  it('refuses a missing phase result, naming it', () => {
    writeFileSync(reportFile(), reportText);
    expect(check()).toEqual({ kind: 'refused', reason: `the RED check could not read its inputs: ${basename(resultFile())} does not exist` });
  });
});

describe('the flow audit artifact published to the PR', () => {
  const publish = (rel: string) => runFinalizeAccess(['publish-flow-audit', repo, '7', rel]);

  it('is not read from a named pipe', async () => {
    const located = artifact('flow-audit.md');
    pipes.at(located.path, '# audit\n');
    await expect(publish(located.rel)).rejects.toThrow('audit artifact is unreadable: not a regular file');
  });

  it('is not read past its size limit', async () => {
    const located = artifact('flow-audit.md');
    writeFileSync(located.path, `# audit\n${pastLimit(MAX_LOOP_ARTIFACT_BYTES)}`);
    await expect(publish(located.rel)).rejects.toThrow(`audit artifact is larger than ${MAX_LOOP_ARTIFACT_BYTES} bytes`);
  });
});

describe('a file the artifact viewer opens', () => {
  const noGit = (): string => {
    throw new Error('not a git repository');
  };

  it('is not read from a named pipe', () => {
    pipes.at(join(repo, 'piped.md'), '# piped\n');
    expect(readArtifact(repo, 'piped.md', { git: noGit })).toBeNull();
  });

  it('is not read past its size limit', () => {
    writeFileSync(join(repo, 'big.md'), 'x'.repeat(MAX_FILE_BYTES + 1));
    expect(readArtifact(repo, 'big.md', { git: noGit })).toBeNull();
  });

  it('is read when it is a regular file', () => {
    writeFileSync(join(repo, 'doc.md'), '# doc\n');
    expect(readArtifact(repo, 'doc.md', { git: noGit })?.body).toBe('# doc\n');
  });
});
