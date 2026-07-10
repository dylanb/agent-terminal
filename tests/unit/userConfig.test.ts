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
      expect(dir.startsWith('/redirected' + path.sep)).toBe(true);
    }
  });
});
