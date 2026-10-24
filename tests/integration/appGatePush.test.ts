import { chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGitRepoFixture, type GitRepoFixture } from '../helpers/gitRepo';
import { createRealAppGatePush } from '../../src/main/appGatePush';

// §28.3 — a gate commit is pushed to the pull request's branch. Real git against a real bare origin (no git
// mock — CLAUDE.md); assertions read the origin's refs and the working repo's remote-tracking ref.

const BRANCH = 'plan-loop/issue-7';

describe('createRealAppGatePush — real git (§28.3)', () => {
  let fx: GitRepoFixture;
  let origin: string;
  let repo: string;
  const tipOf = (dir: string, ref: string): string => fx.git(dir, ['rev-parse', '--verify', ref]);

  beforeEach(() => {
    fx = createGitRepoFixture();
    origin = fx.makeGitRepo('gatepush-origin');
    fx.git(origin, ['config', 'receive.denyCurrentBranch', 'ignore']);
    repo = fx.makeGitRepo('gatepush');
    fx.git(repo, ['remote', 'add', 'origin', origin]);
    fx.writeRepoFile(repo, 'seed.txt', 'seed\n');
    fx.commitAll(repo, 'baseline');
    fx.git(repo, ['checkout', '-q', '-b', BRANCH]);
    fx.git(repo, ['push', '-q', 'origin', BRANCH]);
  });
  afterEach(() => fx.cleanup());

  it('puts the branch tip on the origin branch and records it as the remote-tracking ref', async () => {
    fx.writeRepoFile(repo, 'a.txt', 'a\n');
    const sha = fx.commitAll(repo, 'RED');
    await createRealAppGatePush(repo)(BRANCH);
    expect(tipOf(origin, `refs/heads/${BRANCH}`)).toBe(sha);
    expect(tipOf(repo, `refs/remotes/origin/${BRANCH}`)).toBe(sha);
  });

  it('pushes every commit the origin is missing, not only the newest', async () => {
    fx.writeRepoFile(repo, 'a.txt', 'a\n');
    const first = fx.commitAll(repo, 'RED');
    fx.writeRepoFile(repo, 'b.txt', 'b\n');
    const second = fx.commitAll(repo, 'GREEN');
    await createRealAppGatePush(repo)(BRANCH);
    expect(fx.git(origin, ['rev-list', `refs/heads/${BRANCH}`]).split('\n').slice(0, 2)).toEqual([second, first]);
  });

  it('pushes the named branch even when another branch is checked out', async () => {
    fx.writeRepoFile(repo, 'a.txt', 'a\n');
    const sha = fx.commitAll(repo, 'RED');
    fx.git(repo, ['checkout', '-q', 'main']);
    await createRealAppGatePush(repo)(BRANCH);
    expect(tipOf(origin, `refs/heads/${BRANCH}`)).toBe(sha);
  });

  it('succeeds when the origin already has the tip', async () => {
    const tip = tipOf(repo, 'HEAD');
    await createRealAppGatePush(repo)(BRANCH);
    expect(tipOf(origin, `refs/heads/${BRANCH}`)).toBe(tip);
  });

  it('refuses to overwrite commits on the origin the local branch does not have', async () => {
    const other = fx.makeGitRepo('gatepush-other');
    fx.git(other, ['fetch', '-q', origin, `${BRANCH}:${BRANCH}`]);
    fx.git(other, ['checkout', '-q', BRANCH]);
    fx.writeRepoFile(other, 'theirs.txt', 'theirs\n');
    const theirs = fx.commitAll(other, 'theirs');
    fx.git(other, ['push', '-q', origin, BRANCH]);
    fx.writeRepoFile(repo, 'ours.txt', 'ours\n');
    fx.commitAll(repo, 'ours');
    await expect(createRealAppGatePush(repo)(BRANCH)).rejects.toThrow();
    expect(tipOf(origin, `refs/heads/${BRANCH}`)).toBe(theirs);
  });

  it('fails for a branch that does not exist locally', async () => {
    await expect(createRealAppGatePush(repo)('plan-loop/issue-8')).rejects.toThrow();
  });

  it('never runs a pre-push hook the repository plants', async () => {
    const sentinel = join(repo, 'hook-ran');
    fx.writeRepoFile(repo, '.git/hooks/pre-push', `#!/bin/sh\ntouch '${sentinel}'\n`);
    chmodSync(join(repo, '.git', 'hooks', 'pre-push'), 0o755);
    fx.writeRepoFile(repo, 'a.txt', 'a\n');
    fx.commitAll(repo, 'RED');
    await createRealAppGatePush(repo)(BRANCH);
    expect(existsSync(sentinel)).toBe(false);
  });

  it('refuses an origin whose transport is not an approved one, and pushes nothing', async () => {
    const before = tipOf(origin, `refs/heads/${BRANCH}`);
    fx.git(repo, ['remote', 'set-url', 'origin', `ext::sh -c touch% ${join(repo, 'ext-ran')}`]);
    fx.writeRepoFile(repo, 'a.txt', 'a\n');
    fx.commitAll(repo, 'RED');
    await expect(createRealAppGatePush(repo)(BRANCH)).rejects.toThrow();
    expect(existsSync(join(repo, 'ext-ran'))).toBe(false);
    expect(tipOf(origin, `refs/heads/${BRANCH}`)).toBe(before);
  });
});
