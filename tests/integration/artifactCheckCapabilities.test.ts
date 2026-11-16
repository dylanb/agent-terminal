import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ARTIFACT_CHECK_PASSED, runArtifactCheck, type ArtifactCheck } from '../../src/main/artifactCheck';
import { artifactCheckInputs } from '../../src/main/artifactCheckInputs';
import { loadLoopCapabilities } from '../../src/main/loopCapabilities';
import { exampleRoundReport } from '../../src/shared/roundReport';
import { checkerArgvOf } from '../helpers/artifactCheckArgv';

// The capabilities self-check a setup agent runs from the repository root: the command it is handed runs the
// app's own capabilities reader over the real file, so "my file passes" and "the app accepts it" cannot disagree.

const CAPABILITIES: ArtifactCheck = { kind: 'capabilities' };
const VALID = "test_globs:\n  - 'tests/**/*.test.ts'\ntest_command: npm test\nbuild_command: npm run build\n";
const REJECTED = 'test_globs: []\ntest_command: npm test\nbuild_command: npm run build\n';

let repo: string;
let elsewhere: string;

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'caps-check-repo-')));
  elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'caps-check-elsewhere-')));
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(elsewhere, { recursive: true, force: true });
});

const capabilitiesFile = (): string => join(repo, 'loop-capabilities.yaml');
const checkCapabilities = () => runArtifactCheck(checkerArgvOf(CAPABILITIES), artifactCheckInputs(repo));

describe('the capabilities check the setup agent runs', () => {
  it('passes a file the app reader accepts', () => {
    writeFileSync(capabilitiesFile(), VALID);

    const r = checkCapabilities();

    expect(r.exitCode).toBe(0);
    expect(r.output).toContain(ARTIFACT_CHECK_PASSED);
  });

  const FAILING: Array<{ what: string; arrange: () => void }> = [
    { what: 'a file the reader rejects', arrange: () => writeFileSync(capabilitiesFile(), REJECTED) },
    { what: 'no file', arrange: () => {} },
    {
      what: 'a symlink to a file the reader would accept',
      arrange: () => {
        const target = join(elsewhere, 'loop-capabilities.yaml');
        writeFileSync(target, VALID);
        symlinkSync(target, capabilitiesFile());
      },
    },
  ];
  for (const { what, arrange } of FAILING) {
    it(`fails ${what}, printing the reader's reason`, () => {
      arrange();
      const verdict = loadLoopCapabilities(repo);
      const reason = verdict.ok ? '(the reader accepted it)' : verdict.reason;

      const r = checkCapabilities();

      expect.soft(r.exitCode).toBe(1);
      expect.soft(r.output).toContain(reason);
      expect.soft(r.output).not.toContain(ARTIFACT_CHECK_PASSED);
    });
  }
});

describe('the existing checks read their file from the directory the check runs in', () => {
  const SECTIONS = ['summary', 'findings'];
  const ROSTER = ['impl-review-tests'];
  const REPORT: ArtifactCheck = { kind: 'report', rel: '.agent-terminal/loop/reports/1.json', sections: SECTIONS, roster: ROSTER };

  it('passes a report on disk under that directory, and names it as missing when it is absent', () => {
    const absent = runArtifactCheck(checkerArgvOf(REPORT), artifactCheckInputs(repo));
    mkdirSync(dirname(join(repo, REPORT.rel)), { recursive: true });
    writeFileSync(join(repo, REPORT.rel), exampleRoundReport({ sections: SECTIONS, roster: ROSTER }));

    const present = runArtifactCheck(checkerArgvOf(REPORT), artifactCheckInputs(repo));

    expect(present.exitCode).toBe(0);
    expect(absent.exitCode).toBe(1);
    expect(absent.output).toContain(`${REPORT.rel} does not exist`);
  });
});
