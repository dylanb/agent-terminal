import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentTerminalIgnored } from '../../src/main/gitIgnoreCheck';
import type { ExamplesCurrency } from '../../src/main/installExamples';
import { loadLoopCapabilities } from '../../src/main/loopCapabilities';
import { findRepoRoot } from '../../src/main/repoKey';
import { createSetupCheck } from '../../src/main/setupCheck';
import { MAX_SETUP_DISMISSALS_BYTES, createSetupDismissals, setupDismissalsFile } from '../../src/main/setupDismissals';
import type { SetupConditionEntry, SetupDismissal } from '../../src/shared/setupCheck';
import { createGitRepoFixture, type GitRepoFixture } from '../helpers/gitRepo';
import { createGitUserHome, type GitUserHome } from '../helpers/gitUserHome';
import { writeRepoConditions, type RepoConditionsFixture } from '../helpers/setupRepoConditions';
import { snapshotTree } from '../helpers/treeSnapshot';
import { symlinkSync } from 'node:fs';

// The setup-check dismissals the operator records, kept in one app-owned file under the app-state home, read
// back by every later store over that home, as a restarted app reads them.

let git: GitRepoFixture;
let user: GitUserHome;
let appHome: string;
const scratch: string[] = [];

beforeEach(() => {
  git = createGitRepoFixture();
  user = createGitUserHome();
  user.applyTo(vi.stubEnv);
  appHome = realpathSync(mkdtempSync(join(tmpdir(), 'setup-dismissals-home-')));
  scratch.push(appHome);
});

afterEach(() => {
  vi.unstubAllEnvs();
  user.dispose();
  git.cleanup();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const STALE: ExamplesCurrency = { ok: true, current: false };
const VERSION = '3.0.0-current';

/** The setup check a fresh app launch builds over `appHome`, running `appVersion`, with the examples failing. */
const launchedCheck = (appVersion = VERSION) =>
  createSetupCheck({
    examplesCurrent: () => STALE,
    isGitRepository: (dir) => findRepoRoot(dir) === dir,
    agentTerminalIgnored,
    loadCapabilities: loadLoopCapabilities,
    setupFlowInstalled: () => false,
    appVersion,
    dismissals: createSetupDismissals(appHome),
  });

const repoIn = (conditions: RepoConditionsFixture): string => {
  const repo = realpathSync(git.makeGitRepo('setup-dismissals'));
  writeRepoConditions(repo, conditions);
  return repo;
};

const conditionsListed = async (check: ReturnType<typeof launchedCheck>, repoKey: string): Promise<string[] | string> => {
  const reply = await check.status(repoKey);
  return reply.ok ? reply.entries.map((entry: SetupConditionEntry) => entry.condition).sort() : `not ok: ${reply.reason}`;
};

const byKey = (dismissals: SetupDismissal[]): string[] =>
  dismissals.map((d) => (d.kind === 'repo' ? `repo:${d.repoKey}` : `examples:${d.appVersion}`)).sort();

describe('recording dismissals on a first run', () => {
  it("creates the app-state folder, and a later store over the same home reads back every dismissal recorded", () => {
    rmSync(dirname(setupDismissalsFile(appHome)), { recursive: true, force: true });
    const store = createSetupDismissals(appHome);
    const dismissals: SetupDismissal[] = [
      { kind: 'repo', repoKey: '/work/first-repo' },
      { kind: 'examples', appVersion: VERSION },
      { kind: 'repo', repoKey: '/work/second-repo' },
    ];

    const replies = dismissals.map((d) => store.record(d));

    expect({ replies, readBack: byKey(createSetupDismissals(appHome).recorded()) }).toEqual({
      replies: [{ ok: true }, { ok: true }, { ok: true }],
      readBack: byKey(dismissals),
    });
  });
});

describe('a repository dismissal survives a restart (AC13)', () => {
  it('silences that repository after a restart, while another failing repository still lists its entries', async () => {
    const dismissed = repoIn({ ignored: false, capabilities: 'absent' });
    const other = repoIn({ ignored: false, capabilities: 'absent' });

    const reply = launchedCheck().dismiss({ kind: 'repo', repoKey: dismissed });
    const restarted = launchedCheck();

    expect({
      reply,
      dismissed: await conditionsListed(restarted, dismissed),
      other: await conditionsListed(restarted, other),
    }).toEqual({
      reply: { ok: true },
      dismissed: ['examples'],
      other: ['capabilities', 'examples', 'ignore'],
    });
  });

  it("in one git worktree silences neither another worktree nor the main checkout", async () => {
    const main = realpathSync(git.makeGitRepo('setup-dismissals-main'));
    git.writeRepoFile(main, 'README.md', 'main checkout\n');
    git.commitAll(main, 'initial');
    const worktreeParent = realpathSync(mkdtempSync(join(tmpdir(), 'setup-dismissals-wt-')));
    scratch.push(worktreeParent);
    const first = join(worktreeParent, 'first');
    const second = join(worktreeParent, 'second');
    git.git(main, ['worktree', 'add', '-q', '-b', 'first', first]);
    git.git(main, ['worktree', 'add', '-q', '-b', 'second', second]);

    launchedCheck().dismiss({ kind: 'repo', repoKey: first });
    const restarted = launchedCheck();

    expect({
      first: await conditionsListed(restarted, first),
      second: await conditionsListed(restarted, second),
      main: await conditionsListed(restarted, main),
    }).toEqual({
      first: ['examples'],
      second: ['capabilities', 'examples', 'ignore'],
      main: ['capabilities', 'examples', 'ignore'],
    });
  });
});

describe('an examples dismissal lasts until the app version changes (AC14)', () => {
  it('silences the examples entry after a restart on the same version, and lists it again on another version', async () => {
    const repo = repoIn({ ignored: false, capabilities: 'absent' });

    const reply = launchedCheck(VERSION).dismiss({ kind: 'examples', appVersion: VERSION });

    expect({
      reply,
      sameVersion: await conditionsListed(launchedCheck(VERSION), repo),
      updated: await conditionsListed(launchedCheck('3.1.0-updated'), repo),
    }).toEqual({
      reply: { ok: true },
      sameVersion: ['capabilities', 'ignore'],
      updated: ['capabilities', 'examples', 'ignore'],
    });
  });
});

describe('a dismissal file the store cannot use reads as no dismissals, so the warning still shows', () => {
  const BROKEN: Array<{ what: string; contents: string }> = [
    { what: 'text that is not JSON', contents: 'repos: [/work/a\n' },
    { what: 'JSON of the wrong shape', contents: '{"repos": 42, "examplesVersion": ["3.0.0-current"]}\n' },
    { what: 'a JSON array of values that are not dismissals', contents: '[42, null, "repos"]\n' },
  ];

  for (const { what, contents } of BROKEN) {
    it(`holding ${what}: nothing is silenced, and the next dismissal is recorded in its place`, async () => {
      const repo = repoIn({ ignored: false, capabilities: 'absent' });
      const file = setupDismissalsFile(appHome);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, contents);
      const before = await conditionsListed(launchedCheck(), repo);

      const reply = createSetupDismissals(appHome).record({ kind: 'repo', repoKey: repo });

      expect({ before, reply, after: byKey(createSetupDismissals(appHome).recorded()) }).toEqual({
        before: ['capabilities', 'examples', 'ignore'],
        reply: { ok: true },
        after: [`repo:${repo}`],
      });
    });
  }
});

describe('a dismissal that cannot be written', () => {
  it('answers not ok with a reason, and records nothing', () => {
    const stateDir = dirname(setupDismissalsFile(appHome));
    rmSync(stateDir, { recursive: true, force: true });
    writeFileSync(stateDir, 'a regular file where the app-state folder belongs\n');

    const reply = createSetupDismissals(appHome).record({ kind: 'repo', repoKey: '/work/unwritable' });

    expect({
      ok: reply.ok,
      reason: reply.ok ? null : reply.error.length > 0,
      recorded: createSetupDismissals(appHome).recorded(),
    }).toEqual({ ok: false, reason: true, recorded: [] });
  });

  it('answers not ok with a reason when the app-state folder is a link that never resolves, and records nothing', () => {
    const stateDir = dirname(setupDismissalsFile(appHome));
    rmSync(stateDir, { recursive: true, force: true });
    symlinkSync(stateDir, stateDir);

    const reply = createSetupDismissals(appHome).record({ kind: 'repo', repoKey: '/work/unresolvable' });

    expect({
      ok: reply.ok,
      reason: reply.ok ? null : reply.error.length > 0,
      recorded: createSetupDismissals(appHome).recorded(),
    }).toEqual({ ok: false, reason: true, recorded: [] });
  });

  it.skipIf(process.getuid?.() === 0)('answers not ok with a reason when the app-state folder cannot be written to, and records nothing', () => {
    const stateDir = dirname(setupDismissalsFile(appHome));
    mkdirSync(stateDir, { recursive: true });
    chmodSync(stateDir, 0o500);
    try {
      const reply = createSetupDismissals(appHome).record({ kind: 'repo', repoKey: '/work/read-only' });

      expect({
        ok: reply.ok,
        reason: reply.ok ? null : reply.error.length > 0,
        recorded: createSetupDismissals(appHome).recorded(),
      }).toEqual({ ok: false, reason: true, recorded: [] });
    } finally {
      chmodSync(stateDir, 0o700);
    }
  });
});

describe("recording a dismissal leaves the repository's working tree byte-for-byte unchanged (AC15)", () => {
  const CASES: Array<{ gitignore: string; ignored: boolean }> = [
    { gitignore: 'with no .gitignore', ignored: false },
    { gitignore: 'with a .gitignore of its own', ignored: true },
  ];
  const KINDS = (repoKey: string): SetupDismissal[] => [
    { kind: 'repo', repoKey },
    { kind: 'examples', appVersion: VERSION },
  ];

  for (const { gitignore, ignored } of CASES) {
    for (const kind of ['repo', 'examples'] as const) {
      it(`${gitignore}, for a ${kind} dismissal`, async () => {
        const repo = repoIn({ ignored, capabilities: 'absent' });
        git.writeRepoFile(repo, 'src/app.txt', 'tracked content\n');
        const before = snapshotTree(repo);
        const dismissal = KINDS(repo).find((d) => d.kind === kind)!;

        const reply = launchedCheck().dismiss(dismissal);

        expect({
          reply,
          recorded: byKey(createSetupDismissals(appHome).recorded()),
          treeUnchanged: snapshotTree(repo),
          gitignorePresent: existsSync(join(repo, '.gitignore')),
        }).toEqual({ reply: { ok: true }, recorded: byKey([dismissal]), treeUnchanged: before, gitignorePresent: ignored });
      });
    }
  }
});

describe("an app-state folder the operator made a symbolic link to a real folder", () => {
  it('records a dismissal through the link, and a later store over the same home reads it back', () => {
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'setup-dismissals-linked-')));
    scratch.push(elsewhere);
    const stateDir = dirname(setupDismissalsFile(appHome));
    rmSync(stateDir, { recursive: true, force: true });
    symlinkSync(elsewhere, stateDir);
    const dismissal: SetupDismissal = { kind: 'repo', repoKey: '/work/linked-home' };

    const reply = createSetupDismissals(appHome).record(dismissal);

    expect({ reply, readBack: byKey(createSetupDismissals(appHome).recorded()) }).toEqual({
      reply: { ok: true },
      readBack: byKey([dismissal]),
    });
  });
});

describe('a dismissal file of the right shape holding a value of the wrong type reads as no dismissals', () => {
  const WRONG_FIELD: Array<{ what: string; contents: string }> = [
    { what: 'a repository list holding a value that is not a repository key', contents: '{"repos": ["/work/a", 42], "examplesVersion": null}\n' },
    { what: 'an examples version that is not a string', contents: '{"repos": [], "examplesVersion": 3}\n' },
  ];

  for (const { what, contents } of WRONG_FIELD) {
    it(`holding ${what}: the next dismissal is the only one recorded`, () => {
      const file = setupDismissalsFile(appHome);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, contents);
      const before = byKey(createSetupDismissals(appHome).recorded());

      const reply = createSetupDismissals(appHome).record({ kind: 'repo', repoKey: '/work/clean' });

      expect({ before, reply, after: byKey(createSetupDismissals(appHome).recorded()) }).toEqual({
        before: [],
        reply: { ok: true },
        after: ['repo:/work/clean'],
      });
    });
  }
});

describe('a dismissal file over the size cap reads as no dismissals', () => {
  it('a well-formed record padded just past the cap silences nothing', () => {
    const record = '{"repos": ["/work/a"], "examplesVersion": null}';
    const file = setupDismissalsFile(appHome);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, record.padEnd(MAX_SETUP_DISMISSALS_BYTES + 1, ' '));

    expect(byKey(createSetupDismissals(appHome).recorded())).toEqual([]);
  });
});

describe('dismissing one repository twice', () => {
  it('reads that repository back once', () => {
    const store = createSetupDismissals(appHome);

    const replies = [store.record({ kind: 'repo', repoKey: '/work/a' }), store.record({ kind: 'repo', repoKey: '/work/a' })];

    expect({ replies, readBack: byKey(createSetupDismissals(appHome).recorded()) }).toEqual({
      replies: [{ ok: true }, { ok: true }],
      readBack: ['repo:/work/a'],
    });
  });
});
