import { afterEach, describe, expect, it } from 'vitest';
import { realpathSync } from 'node:fs';
import { flowCatalogDir } from '../../src/main/flow';
import { repoSetupFlowInstalled } from '../../src/main/setupFlowInstalled';
import { REPO_SETUP_FLOW_ID } from '../../src/shared/setupCheck';
import { createCatalogFixture } from '../helpers/catalogFixture';
import { createWorktreeFixture } from '../helpers/worktreeFixture';

// Run setup loop is offered only for the shipped repo-setup flow: the global catalog has the entry and the
// repository's own catalog tier has none (Operator decision 2026-11-04), over real catalog roots on disk.

const worktrees = createWorktreeFixture();
const catalogs = createCatalogFixture();
afterEach(() => {
  worktrees.cleanup();
  catalogs.cleanup();
});

function roots(): { worktreeDir: string; globalRoot: string } {
  return {
    worktreeDir: realpathSync(worktrees.makeWorktree('setup-flow-repo')),
    globalRoot: realpathSync(worktrees.makeWorktree('setup-flow-home')),
  };
}

const install = (root: string): void => void catalogs.addEntry(flowCatalogDir(root), REPO_SETUP_FLOW_ID);

describe('whether the repo-setup flow counts as installed for a repository', () => {
  it('is installed when only the global catalog has the entry', () => {
    const r = roots();
    install(r.globalRoot);
    expect(repoSetupFlowInstalled(r)).toBe(true);
  });

  it('is not installed when the repository has its own entry beside the global one', () => {
    const r = roots();
    install(r.globalRoot);
    install(r.worktreeDir);
    expect(repoSetupFlowInstalled(r)).toBe(false);
  });

  it("is not installed when the repository's own catalog tier cannot be read, even with the global entry", () => {
    const r = roots();
    install(r.globalRoot);
    catalogs.makeUnreadableTier(r.worktreeDir);
    expect(repoSetupFlowInstalled(r)).toBe(false);
  });

  it('is not installed when only the repository has the entry', () => {
    const r = roots();
    install(r.worktreeDir);
    expect(repoSetupFlowInstalled(r)).toBe(false);
  });

  it('is not installed when neither catalog has the entry', () => {
    expect(repoSetupFlowInstalled(roots())).toBe(false);
  });
});
