import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentTerminalIgnored } from '../../src/main/gitIgnoreCheck';
import type { ExamplesCurrency } from '../../src/main/installExamples';
import { loadLoopCapabilities } from '../../src/main/loopCapabilities';
import { findRepoRoot } from '../../src/main/repoKey';
import { createSetupCheck, type SetupCheckDeps } from '../../src/main/setupCheck';
import type { SetupDismissals } from '../../src/main/setupDismissals';
import type { SetupConditionEntry, SetupDismissal } from '../../src/shared/setupCheck';
import { createGitRepoFixture, type GitRepoFixture } from '../helpers/gitRepo';
import { createGitUserHome, type GitUserHome } from '../helpers/gitUserHome';
import { writeRepoConditions, type RepoConditionsFixture } from '../helpers/setupRepoConditions';

// The status main answers for one repository key, over real git, a real capabilities file and the real
// repository-root walk, as the composition root builds it.

let git: GitRepoFixture;
let user: GitUserHome;
const scratch: string[] = [];

beforeEach(() => {
  git = createGitRepoFixture();
  user = createGitUserHome();
  user.applyTo(vi.stubEnv);
});

afterEach(() => {
  vi.unstubAllEnvs();
  user.dispose();
  git.cleanup();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CURRENT: ExamplesCurrency = { ok: true, current: true };
const APP_VERSION = '4.2.0-check';

/** A dismissal store that has recorded exactly `recorded`, and records nothing more. */
const dismissalsOf = (...recorded: SetupDismissal[]): SetupDismissals => ({
  recorded: () => [...recorded],
  record: () => ({ ok: false, reason: 'this store records nothing' }),
});

const realDeps: SetupCheckDeps = {
  examplesCurrent: () => CURRENT,
  isGitRepository: (dir) => findRepoRoot(dir) === dir,
  agentTerminalIgnored,
  loadCapabilities: loadLoopCapabilities,
  appVersion: APP_VERSION,
  dismissals: dismissalsOf(),
};

const repoIn = (conditions: RepoConditionsFixture): string => {
  const repo = realpathSync(git.makeGitRepo('setup-check'));
  writeRepoConditions(repo, conditions);
  return repo;
};

const byCondition = (entries: SetupConditionEntry[]): SetupConditionEntry[] =>
  [...entries].sort((a, b) => a.condition.localeCompare(b.condition));

async function statusOf(repoKey: string, deps: SetupCheckDeps = realDeps) {
  const reply = await createSetupCheck(deps).status(repoKey);
  return reply.ok ? { ...reply, entries: byCondition(reply.entries) } : reply;
}

describe('the repository conditions a git repository fails', () => {
  it('lists capabilities absent when the repository has no loop-capabilities.yaml (AC1)', async () => {
    const repo = repoIn({ ignored: true, capabilities: 'absent' });
    expect(await statusOf(repo)).toEqual({
      ok: true,
      repoKey: repo,
      isRepository: true, appVersion: APP_VERSION,
      entries: [{ condition: 'capabilities', failure: 'absent' }],
    });
  });

  it('lists capabilities malformed for a file the reader rejects (AC2)', async () => {
    const repo = repoIn({ ignored: true, capabilities: 'malformed' });
    expect(await statusOf(repo)).toEqual({
      ok: true,
      repoKey: repo,
      isRepository: true, appVersion: APP_VERSION,
      entries: [{ condition: 'capabilities', failure: 'malformed' }],
    });
  });

  it('lists capabilities malformed for a path the reader cannot read as a file (AC2)', async () => {
    const repo = repoIn({ ignored: true, capabilities: 'not-a-file' });
    expect(await statusOf(repo)).toEqual({
      ok: true,
      repoKey: repo,
      isRepository: true, appVersion: APP_VERSION,
      entries: [{ condition: 'capabilities', failure: 'malformed' }],
    });
  });

  it('lists capabilities confinement for a symlinked loop-capabilities.yaml (AC3)', async () => {
    const repo = repoIn({ ignored: true, capabilities: 'symlink' });
    expect(await statusOf(repo)).toEqual({
      ok: true,
      repoKey: repo,
      isRepository: true, appVersion: APP_VERSION,
      entries: [{ condition: 'capabilities', failure: 'confinement' }],
    });
  });

  it('lists ignore not-ignored when git does not ignore .agent-terminal/ (AC4)', async () => {
    const repo = repoIn({ ignored: false, capabilities: 'valid' });
    expect(await statusOf(repo)).toEqual({
      ok: true,
      repoKey: repo,
      isRepository: true, appVersion: APP_VERSION,
      entries: [{ condition: 'ignore', failure: 'not-ignored' }],
    });
  });

  it('lists ignore not-ignored when only a path beneath .agent-terminal/ is ignored (AC5)', async () => {
    const repo = repoIn({ ignored: false, capabilities: 'valid' });
    writeFileSync(join(repo, '.gitignore'), '.agent-terminal/loop/\n');
    expect(await statusOf(repo)).toEqual({
      ok: true,
      repoKey: repo,
      isRepository: true, appVersion: APP_VERSION,
      entries: [{ condition: 'ignore', failure: 'not-ignored' }],
    });
  });

  it('lists one entry per failing condition when both fail', async () => {
    const repo = repoIn({ ignored: false, capabilities: 'absent' });
    expect(await statusOf(repo)).toEqual({
      ok: true,
      repoKey: repo,
      isRepository: true, appVersion: APP_VERSION,
      entries: [
        { condition: 'capabilities', failure: 'absent' },
        { condition: 'ignore', failure: 'not-ignored' },
      ],
    });
  });

  it('lists nothing for a repository that ignores .agent-terminal/ and has a file the reader accepts (AC4)', async () => {
    const repo = repoIn({ ignored: true, capabilities: 'valid' });
    expect(await statusOf(repo)).toEqual({ ok: true, repoKey: repo, isRepository: true, appVersion: APP_VERSION, entries: [] });
  });
});

describe('an ignore check that could not run never passes (AC6)', () => {
  it('lists ignore unchecked when the ignore check answers unknown', async () => {
    const repo = repoIn({ ignored: true, capabilities: 'valid' });
    const status = await statusOf(repo, { ...realDeps, agentTerminalIgnored: async () => 'unknown' });
    expect(status).toEqual({
      ok: true,
      repoKey: repo,
      isRepository: true, appVersion: APP_VERSION,
      entries: [{ condition: 'ignore', failure: 'unchecked' }],
    });
  });

  it('lists ignore unchecked when the ignore check itself fails', async () => {
    const repo = repoIn({ ignored: true, capabilities: 'valid' });
    const status = await statusOf(repo, {
      ...realDeps,
      agentTerminalIgnored: () => Promise.reject(new Error('spawn failed')),
    });
    expect(status).toEqual({
      ok: true,
      repoKey: repo,
      isRepository: true, appVersion: APP_VERSION,
      entries: [{ condition: 'ignore', failure: 'unchecked' }],
    });
  });

  it('lists ignore unchecked for a repository whose git exits with an error', async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'setup-check-broken-')));
    scratch.push(repo);
    writeFileSync(join(repo, '.git'), `gitdir: ${join(repo, 'no-such-gitdir')}\n`);
    expect(await statusOf(repo)).toEqual({
      ok: true,
      repoKey: repo,
      isRepository: true, appVersion: APP_VERSION,
      entries: [
        { condition: 'capabilities', failure: 'absent' },
        { condition: 'ignore', failure: 'unchecked' },
      ],
    });
  });
});

describe('a directory that is not a git repository (AC9, repository half)', () => {
  it('lists no repository condition, however it would fail them', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'setup-check-plain-')));
    scratch.push(dir);
    writeFileSync(join(dir, 'loop-capabilities.yaml'), 'test_globs: 42\n');
    expect(await statusOf(dir)).toEqual({ ok: true, repoKey: dir, isRepository: false, appVersion: APP_VERSION, entries: [] });
  });
});

describe('the examples condition, for any directory (AC7, AC9 examples half)', () => {
  const STALE: ExamplesCurrency = { ok: true, current: false };

  it('lists examples stale when installing the bundled examples would change something', async () => {
    const repo = repoIn({ ignored: true, capabilities: 'valid' });
    expect(await statusOf(repo, { ...realDeps, examplesCurrent: () => STALE })).toEqual({
      ok: true,
      repoKey: repo,
      isRepository: true, appVersion: APP_VERSION,
      entries: [{ condition: 'examples', failure: 'stale' }],
    });
  });

  it('lists examples unchecked when the installer could not inspect the installation', async () => {
    const repo = repoIn({ ignored: true, capabilities: 'valid' });
    const status = await statusOf(repo, { ...realDeps, examplesCurrent: () => ({ ok: false, error: 'bundle missing' }) });
    expect(status).toEqual({
      ok: true,
      repoKey: repo,
      isRepository: true, appVersion: APP_VERSION,
      entries: [{ condition: 'examples', failure: 'unchecked' }],
    });
  });

  it('lists examples unchecked when the inspection itself throws', async () => {
    const repo = repoIn({ ignored: true, capabilities: 'valid' });
    const status = await statusOf(repo, {
      ...realDeps,
      examplesCurrent: () => {
        throw new Error('scripted inspection failure');
      },
    });
    expect(status).toEqual({
      ok: true,
      repoKey: repo,
      isRepository: true, appVersion: APP_VERSION,
      entries: [{ condition: 'examples', failure: 'unchecked' }],
    });
  });

  it('lists the examples entry beside the repository entries a failing repository lists', async () => {
    const repo = repoIn({ ignored: false, capabilities: 'absent' });
    expect(await statusOf(repo, { ...realDeps, examplesCurrent: () => STALE })).toEqual({
      ok: true,
      repoKey: repo,
      isRepository: true, appVersion: APP_VERSION,
      entries: [
        { condition: 'capabilities', failure: 'absent' },
        { condition: 'examples', failure: 'stale' },
        { condition: 'ignore', failure: 'not-ignored' },
      ],
    });
  });

  it('lists only the examples entry for a directory that is not a git repository', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'setup-check-plain-')));
    scratch.push(dir);
    writeFileSync(join(dir, 'loop-capabilities.yaml'), 'test_globs: 42\n');
    expect(await statusOf(dir, { ...realDeps, examplesCurrent: () => STALE })).toEqual({
      ok: true,
      repoKey: dir,
      isRepository: false, appVersion: APP_VERSION,
      entries: [{ condition: 'examples', failure: 'stale' }],
    });
  });
});

describe('a recorded dismissal stops the status listing what it silences (AC13, AC14)', () => {
  const STALE: ExamplesCurrency = { ok: true, current: false };
  const failingEverything = (...recorded: SetupDismissal[]): SetupCheckDeps => ({
    ...realDeps,
    examplesCurrent: () => STALE,
    dismissals: dismissalsOf(...recorded),
  });
  const EXAMPLES: SetupConditionEntry = { condition: 'examples', failure: 'stale' };
  const REPOSITORY: SetupConditionEntry[] = [
    { condition: 'capabilities', failure: 'absent' },
    { condition: 'ignore', failure: 'not-ignored' },
  ];

  it("a repository dismissal for this repository leaves only the examples entry", async () => {
    const repo = repoIn({ ignored: false, capabilities: 'absent' });
    const status = await statusOf(repo, failingEverything({ kind: 'repo', repoKey: repo }));
    expect(status).toMatchObject({ ok: true, entries: [EXAMPLES] });
  });

  it('a repository dismissal for another repository silences nothing here', async () => {
    const repo = repoIn({ ignored: false, capabilities: 'absent' });
    const other = repoIn({ ignored: false, capabilities: 'absent' });
    const status = await statusOf(repo, failingEverything({ kind: 'repo', repoKey: other }));
    expect(status).toMatchObject({ ok: true, entries: byCondition([EXAMPLES, ...REPOSITORY]) });
  });

  it("an examples dismissal at the running version leaves only the repository entries", async () => {
    const repo = repoIn({ ignored: false, capabilities: 'absent' });
    const status = await statusOf(repo, failingEverything({ kind: 'examples', appVersion: APP_VERSION }));
    expect(status).toMatchObject({ ok: true, entries: REPOSITORY });
  });

  it('an examples dismissal at another version silences nothing', async () => {
    const repo = repoIn({ ignored: false, capabilities: 'absent' });
    const status = await statusOf(repo, failingEverything({ kind: 'examples', appVersion: '4.1.9-older' }));
    expect(status).toMatchObject({ ok: true, entries: byCondition([EXAMPLES, ...REPOSITORY]) });
  });

  it('with both kinds recorded, a failing repository lists nothing', async () => {
    const repo = repoIn({ ignored: false, capabilities: 'absent' });
    const status = await statusOf(
      repo,
      failingEverything({ kind: 'repo', repoKey: repo }, { kind: 'examples', appVersion: APP_VERSION }),
    );
    expect(status).toMatchObject({ ok: true, entries: [] });
  });

  it('an examples dismissal at the running version leaves a directory that is not a repository listing nothing', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'setup-check-plain-')));
    scratch.push(dir);
    const status = await statusOf(dir, failingEverything({ kind: 'examples', appVersion: APP_VERSION }));
    expect(status).toEqual({ ok: true, repoKey: dir, isRepository: false, appVersion: APP_VERSION, entries: [] });
  });
});

describe('dismiss() hands the dismissal to the store and answers what it answered', () => {
  const recordingStore = (answer: ReturnType<SetupDismissals['record']>) => {
    const asked: SetupDismissal[] = [];
    const store: SetupDismissals = {
      recorded: () => [],
      record: (dismissal) => {
        asked.push(dismissal);
        return answer;
      },
    };
    return { store, asked };
  };

  it('passes the dismissal through unchanged and answers ok when the store saved it', () => {
    const { store, asked } = recordingStore({ ok: true });
    const dismissal: SetupDismissal = { kind: 'examples', appVersion: '9.9.9-payload' };
    const reply = createSetupCheck({ ...realDeps, dismissals: store }).dismiss(dismissal);
    expect({ reply, asked }).toEqual({ reply: { ok: true }, asked: [dismissal] });
  });

  it("answers the store's failure and its reason when the store could not save it", () => {
    const { store } = recordingStore({ ok: false, reason: 'scripted store failure' });
    const reply = createSetupCheck({ ...realDeps, dismissals: store }).dismiss({ kind: 'repo', repoKey: '/work/x' });
    expect(reply).toEqual({ ok: false, reason: 'scripted store failure' });
  });
});
