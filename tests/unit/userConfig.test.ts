import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {
  userConfigRoot,
  userConfigRootFrom,
  userClaudeStateFileFrom,
  userConfigLoopsDir,
  userConfigCommandsDir,
} from '../../src/main/userConfig';

// The user-level Claude config root is ONE definition (§24.2.3): the engine's loop-config location and the
// commands location all hang off it, so a single CLAUDE_CONFIG_DIR redirect covers every destination the
// installer writes.

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

  // Why a relative root is refused rather than anchored at cwd (CWE-829) is on `userConfigRootFrom`; the
  // `~/.claude` case is reachable because double quotes do not expand the tilde.
  it.each(['~/.claude', '.claude', 'relative/dir', './cfg', '  spaced/rel  '])(
    'refuses a relative CLAUDE_CONFIG_DIR (%o) rather than anchoring it at process.cwd()',
    (v) => {
      process.env.CLAUDE_CONFIG_DIR = v;
      expect(userConfigRoot()).toBeNull();
      expect(userConfigLoopsDir()).toBeNull();
      expect(userConfigCommandsDir()).toBeNull();
    },
  );

  // The empty-$HOME source of the same sink: os.homedir() returning '' makes the unset branch relative too.
  // Exercised through the injected-home seam (the export's os.homedir() cannot be '' in this process).
  it.each(['', '   ', 'relative/home'])('refuses when the home dir is not absolute (%o) and no override is set', (home) => {
    expect(userConfigRootFrom({}, home)).toBeNull();
  });

  it('resolves against an absolute home when no override is set', () => {
    expect(userConfigRootFrom({}, '/home/me')).toBe(path.join('/home/me', '.claude'));
  });

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
      userConfigCommandsDir(configDir),
    ]) {
      expect(dir).not.toBeNull();
      expect(path.isAbsolute(dir as string)).toBe(true);
    }
  });
});

describe('the destination branches all derive from the one root', () => {
  it('places loops and commands directly under the root', () => {
    const root = '/cfg';
    expect(userConfigLoopsDir(root)).toBe(path.join(root, 'loops'));
    expect(userConfigCommandsDir(root)).toBe(path.join(root, 'commands'));
  });

  it('redirects both together when CLAUDE_CONFIG_DIR moves', () => {
    process.env.CLAUDE_CONFIG_DIR = '/redirected';
    for (const dir of [userConfigLoopsDir(), userConfigCommandsDir()]) {
      expect(dir).not.toBeNull();
      expect((dir as string).startsWith('/redirected' + path.sep)).toBe(true);
    }
  });
});

describe("Claude Code's state file", () => {
  it('sits inside CLAUDE_CONFIG_DIR when set, else at <home>/.claude.json, and is refused for a relative override', () => {
    expect({
      override: userClaudeStateFileFrom({ CLAUDE_CONFIG_DIR: ' /cfg/claude ' }, '/home/op'),
      home: userClaudeStateFileFrom({}, '/home/op'),
      relative: userClaudeStateFileFrom({ CLAUDE_CONFIG_DIR: 'cfg' }, '/home/op'),
    }).toEqual({ override: '/cfg/claude/.claude.json', home: '/home/op/.claude.json', relative: null });
  });
});
