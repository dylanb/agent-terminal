import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function createControllerFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'at-c1-')));
  const dispose = (): void => rmSync(root, { recursive: true, force: true });
  try {
    const home = join(root, 'state');
    const config = join(root, 'config');
    const bin = join(root, 'bin');
    mkdirSync(config);
    mkdirSync(bin);
    const shell = join(bin, 'bash');
    writeFileSync(shell, '#!/bin/sh\nif [ "$1" = "-l" ]; then shift; fi\nif [ "$#" = 0 ]; then printf "started\\n" >> "$CONTROLLER_TEST_SHELL_STARTS"; fi\nexec /bin/bash --noprofile --norc "$@"\n', { mode: 0o700 });
    const env: Record<string, string> = {};
    for (const key of ['HOME', 'PATH', 'DISPLAY', 'XAUTHORITY', 'TMPDIR', 'SystemRoot', 'APP_AGENT_COMMANDS']) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    Object.assign(env, {
      APP_HOME_DIR: home, APP_SHELL: shell, CLAUDE_CONFIG_DIR: config,
      CONTROLLER_TEST_SHELL_STARTS: join(root, 'shell-starts'),
      XDG_CONFIG_HOME: config, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Controller fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Controller fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
      LC_ALL: 'C',
    });
    const git = (cwd: string, ...args: string[]): void => {
      execFileSync('git', ['-C', cwd, ...args], { env, stdio: 'pipe' });
    };
    const repositories = ['left', 'right'].map(parent => {
      const dir = join(root, parent, 'project');
      mkdirSync(dir, { recursive: true });
      git(dir, 'init', '--initial-branch=main', '--template=');
      git(dir, 'config', 'user.name', 'Controller fixture');
      git(dir, 'config', 'user.email', 'fixture@example.invalid');
      git(dir, 'commit', '--allow-empty', '-m', 'fixture');
      // The app names origin's repository on every gh read, so each fixture repository is a GitHub one.
      git(dir, 'remote', 'add', 'origin', `https://github.com/example/${parent}-project.git`);
      return dir;
    });
    const worktrees = ['worktree-a', 'worktree-b'].map(name => {
      const dir = join(root, name);
      git(repositories[0], 'worktree', 'add', '-b', name, dir);
      return dir;
    });
    const nonGit = join(root, 'non-git');
    mkdirSync(nonGit);
    return { root, home, env, repositories, worktrees, nonGit, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
