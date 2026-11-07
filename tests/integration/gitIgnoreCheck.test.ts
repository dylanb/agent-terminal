import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentTerminalIgnored } from '../../src/main/gitIgnoreCheck';
import { shellQuote } from '../../src/shared/shellQuote';
import { createGitRepoFixture, type GitRepoFixture } from '../helpers/gitRepo';
import { createGitUserHome, type GitUserHome } from '../helpers/gitUserHome';

// Real git answers whether its ignore rules cover the whole `.agent-terminal/` folder, through every source it
// reads, with the user's own home and excludes isolated per case.

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

const tempDir = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

/** The check's answer, or what it rejected with: the check answers every case and never rejects. */
const settle = (repo: string): Promise<string> =>
  agentTerminalIgnored(repo).then(
    (answer) => answer,
    (e: unknown) => `rejected: ${e instanceof Error ? e.message : String(e)}`,
  );

/** The answer with `.agent-terminal/` absent, then present as a run leaves it. */
async function answersWithFolderAbsentAndPresent(repo: string): Promise<{ absent: string; present: string }> {
  const absent = await settle(repo);
  git.writeRepoFile(repo, '.agent-terminal/loop/run-state.yaml', 'status: working\n');
  const present = await settle(repo);
  return { absent, present };
}

describe('whether git ignores the whole .agent-terminal/ folder', () => {
  it('answers not-ignored when no ignore source names it', async () => {
    const repo = git.makeGitRepo('ignore-none');
    expect(await answersWithFolderAbsentAndPresent(repo)).toEqual({ absent: 'not-ignored', present: 'not-ignored' });
  });

  it('answers ignored for a .gitignore rule naming the folder with a trailing slash', async () => {
    const repo = git.makeGitRepo('ignore-slash');
    git.writeRepoFile(repo, '.gitignore', '.agent-terminal/\n');
    expect(await answersWithFolderAbsentAndPresent(repo)).toEqual({ absent: 'ignored', present: 'ignored' });
  });

  it('answers ignored for a .gitignore rule naming the folder without a trailing slash', async () => {
    const repo = git.makeGitRepo('ignore-bare');
    git.writeRepoFile(repo, '.gitignore', '.agent-terminal\n');
    expect(await answersWithFolderAbsentAndPresent(repo)).toEqual({ absent: 'ignored', present: 'ignored' });
  });

  it('answers not-ignored when only a path beneath the folder is ignored', async () => {
    const repo = git.makeGitRepo('ignore-beneath');
    git.writeRepoFile(repo, '.gitignore', '.agent-terminal/loop/\n');
    expect(await answersWithFolderAbsentAndPresent(repo)).toEqual({ absent: 'not-ignored', present: 'not-ignored' });
  });

  it('answers ignored for a rule in .git/info/exclude', async () => {
    const repo = git.makeGitRepo('ignore-exclude');
    git.writeRepoFile(repo, '.git/info/exclude', '.agent-terminal/\n');
    expect(await answersWithFolderAbsentAndPresent(repo)).toEqual({ absent: 'ignored', present: 'ignored' });
  });

  it('answers ignored for a rule in the excludes file the user config names', async () => {
    const repo = git.makeGitRepo('ignore-excludesfile');
    git.git(repo, ['config', '--global', 'core.excludesFile', user.writeExcludesFile('.agent-terminal/\n')]);
    expect(await answersWithFolderAbsentAndPresent(repo)).toEqual({ absent: 'ignored', present: 'ignored' });
  });

  it("answers ignored for a rule in the user's default global excludes file", async () => {
    const repo = git.makeGitRepo('ignore-default-global');
    user.writeDefaultExcludes('.agent-terminal/\n');
    expect(await answersWithFolderAbsentAndPresent(repo)).toEqual({ absent: 'ignored', present: 'ignored' });
  });
});

describe('a git that cannot answer', () => {
  it('answers unknown when git exits with an error (a .git file naming a missing gitdir)', async () => {
    const repo = tempDir('ignore-broken-');
    writeFileSync(join(repo, '.git'), `gitdir: ${join(repo, 'no-such-gitdir')}\n`);
    expect(await settle(repo)).toBe('unknown');
  });

  it('answers unknown when there is no git on PATH', async () => {
    const repo = git.makeGitRepo('ignore-no-git');
    vi.stubEnv('PATH', tempDir('no-git-path-'));
    expect(await settle(repo)).toBe('unknown');
  });
});

describe("the repository's own git config", () => {
  it('cannot run a planted fsmonitor while the check reads the index', async () => {
    const repo = git.makeGitRepo('ignore-fsmonitor');
    git.writeRepoFile(repo, 'tracked.txt', 'tracked\n');
    git.commitAll(repo, 'seed');
    const marker = join(tempDir('fsmonitor-marker-'), 'ran');
    const hook = join(tempDir('fsmonitor-hook-'), 'fsmonitor.sh');
    writeFileSync(hook, `#!/bin/sh\ntouch ${shellQuote(marker)}\nexit 1\n`);
    chmodSync(hook, 0o755);
    git.git(repo, ['config', 'core.fsmonitor', hook]);
    mkdirSync(join(repo, '.agent-terminal'));

    const answer = await settle(repo);

    expect({ answer, fsmonitorRan: existsSync(marker) }).toEqual({ answer: 'not-ignored', fsmonitorRan: false });
  });
});
