import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { codexAgentsDir, codexHomeFrom, codexLoopsV2Dir, codexSkillsDir } from '../../src/main/codexConfig';

// Codex's home is ONE definition (§18.1): every Codex destination the installer writes hangs off it,
// so a single CODEX_HOME redirect moves all of them together.

describe('codexHomeFrom', () => {
  it('defaults to <home>/.codex when CODEX_HOME is unset', () => {
    expect(codexHomeFrom({}, '/home/me')).toBe(path.join('/home/me', '.codex'));
  });

  it('reads CODEX_HOME when it is set', () => {
    expect(codexHomeFrom({ CODEX_HOME: '/opt/codex' }, '/home/me')).toBe('/opt/codex');
  });

  it.each(['', '   '])('treats a CODEX_HOME of %o as unset', (v) => {
    expect(codexHomeFrom({ CODEX_HOME: v }, '/home/me')).toBe(path.join('/home/me', '.codex'));
  });

  it('trims a padded absolute CODEX_HOME', () => {
    expect(codexHomeFrom({ CODEX_HOME: '  /opt/codex  ' }, '/home/me')).toBe('/opt/codex');
  });

  // Codex resolves a relative value against its own cwd, so it names no single directory (CWE-829).
  it.each(['~/.codex', '.codex', 'relative/dir'])('refuses a relative CODEX_HOME (%o)', (v) => {
    expect(codexHomeFrom({ CODEX_HOME: v }, '/home/me')).toBeNull();
  });

  it.each(['', '   ', 'relative/home'])('refuses when the home dir is not absolute (%o) and CODEX_HOME is unset', (home) => {
    expect(codexHomeFrom({}, home)).toBeNull();
  });
});

describe('codexLoopsV2Dir', () => {
  it('is the loops-v2 directory under the Codex home', () => {
    expect(codexLoopsV2Dir('/opt/codex')).toBe(path.join('/opt/codex', 'loops-v2'));
  });
});

describe('codexAgentsDir', () => {
  it('is the agents directory under the Codex home, where Codex discovers a custom agent', () => {
    expect(codexAgentsDir('/opt/codex')).toBe(path.join('/opt/codex', 'agents'));
  });
});

describe('codexSkillsDir', () => {
  it('is the skills directory under the Codex home, where Codex discovers a skill', () => {
    expect(codexSkillsDir('/opt/codex')).toBe(path.join('/opt/codex', 'skills'));
  });
});
