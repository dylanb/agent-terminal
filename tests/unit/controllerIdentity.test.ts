import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createControllerFixture } from '../helpers/controllerFixture';
import { captureControllerIdentity } from '../../src/main/controllerIdentity';

describe('fixed controller launch identity', () => {
  let fixture: ReturnType<typeof createControllerFixture>;
  beforeEach(() => { fixture = createControllerFixture(); });
  afterEach(() => fixture.dispose());

  it('identifies a repository root', () => {
    const root = fixture.repositories[0];
    expect(captureControllerIdentity(root)).toEqual({ launchDirectory: root, repositoryRoot: root });
  });

  it('keeps the nested launch directory distinct from its repository', () => {
    const root = fixture.repositories[0];
    const nested = join(root, 'nested');
    mkdirSync(nested);
    expect(captureControllerIdentity(nested)).toEqual({ launchDirectory: nested, repositoryRoot: root });
  });

  it.each([0, 1])('identifies linked worktree %i by its own root', index => {
    const root = fixture.worktrees[index];
    expect(captureControllerIdentity(root)).toEqual({ launchDirectory: root, repositoryRoot: root });
  });

  it('identifies a non-Git directory without inventing a repository', () => {
    expect(captureControllerIdentity(fixture.nonGit)).toEqual({ launchDirectory: fixture.nonGit, repositoryRoot: null });
  });
});
