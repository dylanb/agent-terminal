import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { resolveLaunchRoot, homeFallback } from '../../src/main/launchRoot';

const FALLBACK = '/home/fallback-marker';

describe('homeFallback (§23.4 — F: the $HOME-else-OS-home value resolveLaunchRoot returns verbatim when the target is absent or unusable)', () => {
  it('uses $HOME when set', () => {
    expect(homeFallback({ HOME: '/home/u' }, '/fallback')).toBe('/home/u');
  });
  it('falls back to the home arg when $HOME is unset or empty', () => {
    expect(homeFallback({}, '/fallback')).toBe('/fallback');
    expect(homeFallback({ HOME: '' }, '/fallback')).toBe('/fallback');
  });
});

// accessSync(X_OK) cannot be provoked to throw as root, and Windows lacks the traverse bit.
const CAN_TEST_UNENTERABLE =
  process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0;

describe('resolveLaunchRoot (§23.4 — launch root: validated target, else F)', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'launch-root-'));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('resolves an existing directory to its real path', () => {
    const dir = join(base, 'workdir');
    mkdirSync(dir);
    expect(resolveLaunchRoot(dir, FALLBACK)).toBe(realpathSync(dir));
  });

  it('resolves a relative target to its absolute real path', () => {
    const dir = join(base, 'reldir');
    mkdirSync(dir);
    const rel = relative(process.cwd(), dir);
    expect(resolveLaunchRoot(rel, FALLBACK)).toBe(realpathSync(dir));
  });

  it('canonicalizes a symlinked target to the link destination', () => {
    const dest = join(base, 'dest');
    mkdirSync(dest);
    const link = join(base, 'link');
    symlinkSync(dest, link);
    expect(resolveLaunchRoot(link, FALLBACK)).toBe(realpathSync(dest));
  });

  it('falls back to F when the target does not exist', () => {
    expect(resolveLaunchRoot(join(base, 'nope'), FALLBACK)).toBe(FALLBACK);
  });

  it('falls back to F when the target is a file, not a directory', () => {
    const file = join(base, 'a-file');
    writeFileSync(file, 'x');
    expect(resolveLaunchRoot(file, FALLBACK)).toBe(FALLBACK);
  });

  it('falls back to F when the target is a broken symlink', () => {
    const link = join(base, 'broken');
    symlinkSync(join(base, 'missing'), link);
    expect(resolveLaunchRoot(link, FALLBACK)).toBe(FALLBACK);
  });

  it('falls back to F when an existing directory cannot be entered (no traverse permission)', () => {
    const dir = join(base, 'locked');
    mkdirSync(dir);
    expect(resolveLaunchRoot(dir, FALLBACK, () => false)).toBe(FALLBACK);
  });

  it.skipIf(!CAN_TEST_UNENTERABLE)(
    'falls back to F for a real directory with no traverse permission (default canEnter)',
    () => {
      const dir = join(base, 'no-x');
      mkdirSync(dir);
      chmodSync(dir, 0o000);
      try {
        expect(resolveLaunchRoot(dir, FALLBACK)).toBe(FALLBACK);
      } finally {
        chmodSync(dir, 0o700);
      }
    },
  );

  it('falls back to F when no target is given', () => {
    expect(resolveLaunchRoot(undefined, FALLBACK)).toBe(FALLBACK);
  });

  it('falls back to F for an empty-string target', () => {
    expect(resolveLaunchRoot('', FALLBACK)).toBe(FALLBACK);
  });

  it('returns F verbatim on fallback — never canonicalized', () => {
    expect(resolveLaunchRoot(undefined, FALLBACK)).toBe(FALLBACK);
    expect(resolveLaunchRoot('/does/not/exist', FALLBACK)).toBe(FALLBACK);
  });
});
