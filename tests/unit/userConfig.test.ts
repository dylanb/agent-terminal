import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {
  userConfigRoot,
  userConfigLoopsDir,
  userConfigSkillsDir,
  userConfigCommandsDir,
} from '../../src/main/userConfig';

// The user-level Claude config root is ONE definition (§24.2.3): the engine's loop-config location, the
// skills location and the commands location all hang off it, so a single CLAUDE_CONFIG_DIR redirect
// covers every destination the installer writes.

const priorConfigDir = process.env.CLAUDE_CONFIG_DIR;
afterEach(() => {
  if (priorConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = priorConfigDir;
});

describe('userConfigRoot', () => {
  it('prefers the explicit argument over the environment and the home default', () => {
    process.env.CLAUDE_CONFIG_DIR = '/from/env';
    expect(userConfigRoot('/explicit')).toBe('/explicit');
  });

  it('reads CLAUDE_CONFIG_DIR when no argument is given', () => {
    process.env.CLAUDE_CONFIG_DIR = '/from/env';
    expect(userConfigRoot()).toBe('/from/env');
  });

  it('defaults to ~/.claude when neither is set', () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(userConfigRoot()).toBe(path.join(os.homedir(), '.claude'));
  });

  // An exported-but-empty CLAUDE_CONFIG_DIR means UNSET, not "the empty path". A root of '' makes every
  // destination a bare relative name, which the install then anchors at process.cwd() — seeding the user's
  // checked-out repo instead of their config (CLAUDE.md: never allow an unrecoverable state).
  it.each([
    ['an empty environment variable', () => (process.env.CLAUDE_CONFIG_DIR = '')],
    ['a whitespace-only environment variable', () => (process.env.CLAUDE_CONFIG_DIR = '   ')],
  ])('treats %s as unset', (_label, set) => {
    set();
    expect(userConfigRoot()).toBe(path.join(os.homedir(), '.claude'));
  });

  // A RELATIVE override is the same defect wearing a different costume, and it is REACHABLE:
  // `export CLAUDE_CONFIG_DIR="~/.claude"` does not expand the tilde inside double quotes, so the value is
  // literally relative. `path.resolve()` would anchor it at THIS process's cwd — which is not even the cwd
  // Claude Code (a separate process) resolves the same variable against, so no cwd we could pick is right.
  // Anchoring at ours seeds a directory nobody reads, and when the app was launched from a repo it lands in
  // the user's working tree — where `loopDef` would then stamp it `operator-config`, the origin §26.6 hangs
  // `exec` authority on (CWE-829). It is refused, not guessed at.
  it.each(['~/.claude', '.claude', 'relative/dir', './cfg', '  spaced/rel  '])(
    'refuses a relative CLAUDE_CONFIG_DIR (%o) rather than anchoring it at process.cwd()',
    (v) => {
      process.env.CLAUDE_CONFIG_DIR = v;
      expect(userConfigRoot()).toBeNull();
      expect(userConfigLoopsDir()).toBeNull();
      expect(userConfigSkillsDir()).toBeNull();
      expect(userConfigCommandsDir()).toBeNull();
    },
  );

  it('refuses a relative explicit argument too — the same domain, whichever door it arrives through', () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(userConfigRoot('relative/dir')).toBeNull();
  });

  it('trims a padded ABSOLUTE value rather than leaving it relative', () => {
    process.env.CLAUDE_CONFIG_DIR = '  /Users/x/.claude  ';
    expect(userConfigRoot()).toBe(path.join('/Users/x/.claude'));
  });

  it.each([undefined, '', '   '])('never yields a relative destination for a root of %o', (configDir) => {
    delete process.env.CLAUDE_CONFIG_DIR;
    for (const dir of [
      userConfigLoopsDir(configDir),
      userConfigSkillsDir(configDir),
      userConfigCommandsDir(configDir),
    ]) {
      expect(dir).not.toBeNull();
      expect(path.isAbsolute(dir as string)).toBe(true);
    }
  });
});

describe('the three destination branches all derive from the one root', () => {
  it('places loops, skills and commands directly under the root', () => {
    const root = '/cfg';
    expect(userConfigLoopsDir(root)).toBe(path.join(root, 'loops'));
    expect(userConfigSkillsDir(root)).toBe(path.join(root, 'skills'));
    expect(userConfigCommandsDir(root)).toBe(path.join(root, 'commands'));
  });

  it('redirects all three together when CLAUDE_CONFIG_DIR moves', () => {
    process.env.CLAUDE_CONFIG_DIR = '/redirected';
    for (const dir of [userConfigLoopsDir(), userConfigSkillsDir(), userConfigCommandsDir()]) {
      expect(dir).not.toBeNull();
      expect((dir as string).startsWith('/redirected' + path.sep)).toBe(true);
    }
  });
});
