import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadLoopCapabilities,
  LOOP_CAPABILITIES_FILENAME,
} from '../../src/main/loopCapabilities';

const WELL_FORMED = 'test_globs: [tests/**]\ntest_command: pnpm test\nbuild_command: pnpm run build\n';

describe('loadLoopCapabilities (§28.5.4) — confined read of an untrusted repo working tree', () => {
  const cleanup: string[] = [];
  afterEach(() => {
    while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
  });
  function repoDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
    cleanup.push(dir);
    return dir;
  }

  it('loads and parses a well-formed capabilities file', () => {
    const dir = repoDir('caps-ok');
    writeFileSync(join(dir, LOOP_CAPABILITIES_FILENAME), WELL_FORMED);
    expect(loadLoopCapabilities(dir)).toEqual({
      ok: true,
      value: { testGlobs: ['tests/**'], testCommand: 'pnpm test', buildCommand: 'pnpm run build' },
    });
  });

  it('reports cause "absent" (distinct from malformed) when the file is missing', () => {
    const dir = repoDir('caps-absent');
    const r = loadLoopCapabilities(dir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.cause).toBe('absent');
  });

  it('reports cause "malformed" for an ill-formed file', () => {
    const dir = repoDir('caps-bad');
    writeFileSync(join(dir, LOOP_CAPABILITIES_FILENAME), 'test_globs: [unterminated\n');
    const r = loadLoopCapabilities(dir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.cause).toBe('malformed');
  });

  it('reports cause "confinement" when the file is a symlink escaping the repo (CWE-59)', () => {
    const outside = repoDir('caps-outside');
    const secret = join(outside, 'secret.yaml');
    writeFileSync(secret, WELL_FORMED);
    const dir = repoDir('caps-escape');
    symlinkSync(secret, join(dir, LOOP_CAPABILITIES_FILENAME));
    const r = loadLoopCapabilities(dir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.cause).toBe('confinement');
  });

  it('reports cause "malformed" when the capabilities path is a directory, not a regular file', () => {
    const dir = repoDir('caps-dir');
    mkdirSync(join(dir, LOOP_CAPABILITIES_FILENAME));
    const r = loadLoopCapabilities(dir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.cause).toBe('malformed');
  });
});
