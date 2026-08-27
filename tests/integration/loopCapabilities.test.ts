import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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

  it('reports cause "confinement" when the capabilities file is a symlink INSIDE the repo (read is no-follow, CWE-59/367)', () => {
    // The prior stat-then-read followed a symlink whose realpath stayed in the jail, so an attacker who owns the
    // untrusted working tree could plant a link (or swap it under the stat↔read window). The read must not follow
    // a link at the capabilities path: the file has to be a real regular file, or it is refused.
    const dir = repoDir('caps-inside-link');
    const real = join(dir, 'real-caps.yaml');
    writeFileSync(real, WELL_FORMED);
    symlinkSync(real, join(dir, LOOP_CAPABILITIES_FILENAME));
    const r = loadLoopCapabilities(dir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.cause).toBe('confinement');
  });

  it('does not hang and reports "malformed" when the capabilities path is a FIFO (no-block open, §28.5.4)', () => {
    // A named pipe at the path would block a plain open() forever (a main-process DoS). The read opens non-
    // blocking and rejects a non-regular file — this test would TIME OUT rather than fail if that regressed.
    const dir = repoDir('caps-fifo');
    execFileSync('mkfifo', [join(dir, LOOP_CAPABILITIES_FILENAME)]);
    const r = loadLoopCapabilities(dir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.cause).toBe('malformed');
  });

  it('reports cause "malformed" for invalid UTF-8 bytes rather than normalizing them (U+FFFD would fail-away)', () => {
    const dir = repoDir('caps-badutf8');
    // valid yaml STRUCTURE but a test_globs value carrying an invalid UTF-8 byte: a lossy decode would make it a
    // valid object with a U+FFFD-altered glob (silently matching nothing); a fatal decode rejects it.
    const bytes = Buffer.concat([
      Buffer.from('test_globs: ["tests/'),
      Buffer.from([0xff]),
      Buffer.from('.ts"]\ntest_command: t\nbuild_command: b\n'),
    ]);
    writeFileSync(join(dir, LOOP_CAPABILITIES_FILENAME), bytes);
    const r = loadLoopCapabilities(dir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.cause).toBe('malformed');
  });

  it('reports cause "malformed" when the capabilities path is a directory, not a regular file', () => {
    const dir = repoDir('caps-dir');
    mkdirSync(join(dir, LOOP_CAPABILITIES_FILENAME));
    const r = loadLoopCapabilities(dir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.cause).toBe('malformed');
  });

  it('enforces the 512 KiB size cap: rejects just-over and accepts exactly-at-cap (§28.5.4 CWE-400/770)', () => {
    const CAP = 512 * 1024; // MAX_CAPABILITIES_BYTES — the cap is part of the §28.5.4 contract, pinned here.
    const over = repoDir('caps-too-big');
    writeFileSync(join(over, LOOP_CAPABILITIES_FILENAME), `${WELL_FORMED}# ${'x'.repeat(CAP)}\n`);
    const rOver = loadLoopCapabilities(over);
    expect(rOver.ok).toBe(false);
    if (!rOver.ok) {
      expect(rOver.cause).toBe('malformed');
      expect(rOver.reason).toContain('too large');
    }

    // Exactly at the cap → `size > CAP` is false → still read and parsed (the boundary is inclusive).
    const at = repoDir('caps-at-cap');
    const filler = `# ${'x'.repeat(CAP - Buffer.byteLength(WELL_FORMED) - 3)}\n`;
    const atCap = `${WELL_FORMED}${filler}`;
    expect(Buffer.byteLength(atCap)).toBe(CAP);
    writeFileSync(join(at, LOOP_CAPABILITIES_FILENAME), atCap);
    expect(loadLoopCapabilities(at)).toEqual({
      ok: true,
      value: { testGlobs: ['tests/**'], testCommand: 'pnpm test', buildCommand: 'pnpm run build' },
    });
  });
});
