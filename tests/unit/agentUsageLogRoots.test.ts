import { describe, expect, expectTypeOf, it, onTestFinished } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { agentWorkingDir, claudeCodeProjectLogDir, codexSessionsDir, type AgentWorkingDir } from '../../src/main/agentUsage/logRoots';

// A literal standing for a directory an agent ran in, so the folder-naming rule is checked against hand-written names.
const ranIn = (dir: string): AgentWorkingDir => dir as AgentWorkingDir;

describe('agentWorkingDir', () => {
  it('is the real path of a worktree reached through a symlink, as an agent records its working directory', () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'log-roots-')));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(path.join(root, 'real', 'repo.x'), { recursive: true });
    symlinkSync(path.join(root, 'real'), path.join(root, 'link'));
    expect(agentWorkingDir(path.join(root, 'link', 'repo.x'))).toBe(path.join(root, 'real', 'repo.x'));
  });
});

describe('claudeCodeProjectLogDir', () => {
  it('names the folder Claude Code logs a working directory in, every non-alphanumeric character a dash', () => {
    expect(claudeCodeProjectLogDir('/cfg', ranIn('/Users/dev/src/app.v2/feature_x'))).toBe(
      path.join('/cfg', 'projects', '-Users-dev-src-app-v2-feature-x'),
    );
  });

  it('keeps a dash for each character, so a dot after a slash reads as two dashes', () => {
    expect(claudeCodeProjectLogDir('/home/me/.claude', ranIn('/Users/dev/factory/.claude/worktrees/29-run'))).toBe(
      path.join('/home/me/.claude', 'projects', '-Users-dev-factory--claude-worktrees-29-run'),
    );
  });

  it('keeps letters and digits as they are, case included', () => {
    expect(claudeCodeProjectLogDir('/cfg', ranIn('/Work/Repo42'))).toBe(path.join('/cfg', 'projects', '-Work-Repo42'));
  });

  it('names a folder only from a directory agentWorkingDir resolved, never from a path as given', () => {
    expectTypeOf<string>().not.toExtend<Parameters<typeof claudeCodeProjectLogDir>[1]>();
  });
});

describe('codexSessionsDir', () => {
  it('is the sessions folder under the Codex home', () => {
    expect(codexSessionsDir('/opt/codex')).toBe(path.join('/opt/codex', 'sessions'));
  });
});
