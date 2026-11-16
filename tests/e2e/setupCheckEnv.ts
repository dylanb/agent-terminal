import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitUserHome, type GitUserHome } from '../helpers/gitUserHome';
import { writeGitStubBin, type GitStubBin } from '../helpers/gitStubBin';

type LaunchEnv = Record<string, string | undefined>;

/** The startup setup check raises a blocking modal, which would sit over every spec that does not test it, so
 *  a launch turns it off unless its own `env` sets `APP_SETUP_CHECK`. */
export function withSetupCheckOff(env: LaunchEnv | undefined): LaunchEnv {
  return env !== undefined && 'APP_SETUP_CHECK' in env ? env : { ...env, APP_SETUP_CHECK: 'off' };
}

/** The machine state a setup-check spec launches the app over (git user home, empty git config files, app and
 *  tool homes), created once per case and passed unchanged to every launch in it, so the dismissal file and installed examples survive a restart. The examples condition
 *  starts failing (empty app home and Claude config) and the Codex home does not exist, so the installer skips
 *  its destinations. */
export interface SetupCheckMachine {
  readonly appHome: string;
  readonly claudeConfigDir: string;
  readonly gitUser: GitUserHome;
  /** Setup check on, plus every path above and the git user env. Spread the spec's own keys over it. */
  readonly env: LaunchEnv;
  dispose(): void;
}

export function createSetupCheckMachine(): SetupCheckMachine {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'setup-check-machine-')));
  const appHome = join(root, 'app-home');
  const claudeConfigDir = join(root, 'claude-config');
  mkdirSync(appHome);
  mkdirSync(claudeConfigDir);
  const gitUser = createGitUserHome();
  const emptyGitConfig = join(root, 'empty.gitconfig');
  writeFileSync(emptyGitConfig, '');
  return {
    appHome,
    claudeConfigDir,
    gitUser,
    env: {
      ...gitUser.env,
      GIT_CONFIG_GLOBAL: emptyGitConfig,
      GIT_CONFIG_SYSTEM: emptyGitConfig,
      APP_SETUP_CHECK: 'on',
      APP_HOME_DIR: appHome,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      CODEX_HOME: join(root, 'no-codex-home'),
    },
    dispose() {
      gitUser.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A `git` for the launched app's PATH whose `check-ignore` fails as a broken repository does (exit 128),
 *  after any leading global options; every other command runs the real git. */
export function failingCheckIgnoreGit(): GitStubBin {
  return writeGitStubBin([{ argvPrefix: ['check-ignore'], stderr: 'fatal: scripted check-ignore failure\n', exitCode: 128 }]);
}
