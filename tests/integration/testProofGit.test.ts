import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGitRepoFixture, type GitRepoFixture } from '../helpers/gitRepo';
import { createProofWorkingTree } from '../../src/main/testProofPorts';

let git: GitRepoFixture;
let repo: string;
let head: string;

beforeEach(() => {
  git = createGitRepoFixture();
  repo = git.makeGitRepo('test-proof-git');
  git.writeRepoFile(repo, '.gitignore', 'ignored/\n');
  git.writeRepoFile(repo, 'tracked.txt', 'one\n');
  git.git(repo, ['checkout', '-q', '-b', 'feature/proof']);
  head = git.commitAll(repo, 'base');
});

afterEach(() => git.cleanup());

describe('the proof working-tree adapter (real git)', () => {
  it('reads a committed tree as clean, with HEAD and the branch', async () => {
    const tree = createProofWorkingTree(repo);
    expect.soft(await tree.dirtyPaths()).toEqual([]);
    expect.soft(await tree.head()).toBe(head);
    expect.soft(await tree.branch()).toBe('feature/proof');
  });

  it('reads an unstaged change to a tracked file as dirty', async () => {
    git.writeRepoFile(repo, 'tracked.txt', 'two\n');
    expect(await createProofWorkingTree(repo).dirtyPaths()).not.toEqual([]);
  });

  it('reads a staged change as dirty', async () => {
    git.writeRepoFile(repo, 'staged.txt', 'new\n');
    git.git(repo, ['add', 'staged.txt']);
    expect(await createProofWorkingTree(repo).dirtyPaths()).not.toEqual([]);
  });

  it('reads an untracked, non-ignored file as dirty', async () => {
    git.writeRepoFile(repo, 'untracked.txt', 'loose\n');
    expect(await createProofWorkingTree(repo).dirtyPaths()).not.toEqual([]);
  });

  it('reads an untracked file as dirty when the repository is configured to hide untracked files', async () => {
    git.git(repo, ['config', 'status.showUntrackedFiles', 'no']);
    git.writeRepoFile(repo, 'untracked.txt', 'loose\n');
    expect(await createProofWorkingTree(repo).dirtyPaths()).not.toEqual([]);
  });

  it('reads a git-ignored file as clean, beside an untracked file that is dirty', async () => {
    git.writeRepoFile(repo, 'ignored/report.json', '{}\n');
    git.writeRepoFile(repo, 'untracked.txt', 'loose\n');
    const dirty = await createProofWorkingTree(repo).dirtyPaths();
    expect.soft(dirty).toHaveLength(1);
    expect.soft(dirty.filter((path) => path.includes('ignored'))).toEqual([]);
  });

  it('reads a detached HEAD as no branch, with its commit as HEAD', async () => {
    git.git(repo, ['checkout', '-q', '--detach']);
    const tree = createProofWorkingTree(repo);
    expect.soft(await tree.branch()).toBeNull();
    expect.soft(await tree.head()).toBe(head);
  });
});

describe('the proof working-tree adapter with an untracked directory', () => {
  it('reads an untracked directory as one dirty entry, however many files it holds', async () => {
    for (const name of ['a.txt', 'b.txt', 'c.txt']) git.writeRepoFile(repo, `stray/${name}`, 'loose\n');
    expect(await createProofWorkingTree(repo).dirtyPaths()).toHaveLength(1);
  });
});
