import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { resolveLaunchRoot, homeFallback, resolveAppHome, resolveLaunchSurfaces, APP_LAUNCH_DIR_ENV, APP_HOME_DIR_ENV } from '../../src/main/launchRoot';

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

describe('resolveAppHome (§23.4 — the app-state home under which ~/.agent-terminal lives: APP_HOME_DIR override, else F)', () => {
  it('uses an absolute APP_HOME_DIR, overriding $HOME', () => {
    expect(resolveAppHome({ HOME: '/home/u', [APP_HOME_DIR_ENV]: '/alt/state' }, '/os')).toBe('/alt/state');
  });
  it('ignores a RELATIVE APP_HOME_DIR (no single meaning from this process cwd — CWE-829) and falls back to F', () => {
    expect(resolveAppHome({ HOME: '/home/u', [APP_HOME_DIR_ENV]: 'rel/state' }, '/os')).toBe('/home/u');
  });
  it('ignores a blank APP_HOME_DIR and falls back to F', () => {
    expect(resolveAppHome({ HOME: '/home/u', [APP_HOME_DIR_ENV]: '   ' }, '/os')).toBe('/home/u');
  });
  it('falls back to F ($HOME else the OS home) when APP_HOME_DIR is unset', () => {
    expect(resolveAppHome({ HOME: '/home/u' }, '/os')).toBe('/home/u');
    expect(resolveAppHome({}, '/os')).toBe('/os');
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

// The launch surfaces split: the shell cwd / viewer root / todo scope read the launch root L, but the
// GLOBAL flow definition (§18.1) lives at the per-user home — independent of L, so a global flow at
// ~/.agent-terminal/flow.yaml resolves regardless of where the instance was launched. (The launch
// root is the local-first repo anchor's job, never the global one.)
describe('resolveLaunchSurfaces (§23.4/§18.1 — launch root for the cwd surfaces, home for the flow global dir)', () => {
  let base: string;
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'launch-surfaces-')));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('roots the flow global dir at $HOME, independent of a usable launch target', () => {
    const home = join(base, 'home');
    const target = join(base, 'launch-elsewhere');
    mkdirSync(home);
    mkdirSync(target);
    const env: NodeJS.ProcessEnv = { HOME: home, [APP_LAUNCH_DIR_ENV]: target };
    const surfaces = resolveLaunchSurfaces(env, '/os-home-unused');
    expect(surfaces.launchRoot).toBe(realpathSync(target)); // L = the target, for shell/viewer/scope
    expect(surfaces.flowGlobalDir).toBe(home); // but the flow global dir is HOME, never L
  });

  it('roots the flow global dir at the OS home when $HOME is unset', () => {
    const osHome = join(base, 'os-home');
    mkdirSync(osHome);
    const surfaces = resolveLaunchSurfaces({}, osHome);
    expect(surfaces.flowGlobalDir).toBe(osHome);
    expect(surfaces.launchRoot).toBe(osHome); // no target → L falls back to F = the same home
  });

  it('relocates the flow global dir to APP_HOME_DIR while the launch root stays on the real home (decoupled)', () => {
    // APP_HOME_DIR moves the app-STATE home (flow.yaml/audit) — NOT the shell cwd, which stays on the real
    // home (or APP_LAUNCH_DIR). The two axes are independent: pointing state at a sandbox must not move the
    // terminal's working directory.
    const appState = join(base, 'app-state');
    const home = join(base, 'home');
    mkdirSync(appState);
    mkdirSync(home);
    const env: NodeJS.ProcessEnv = { HOME: home, [APP_HOME_DIR_ENV]: appState };
    const surfaces = resolveLaunchSurfaces(env, '/os-home-unused');
    expect(surfaces.flowGlobalDir).toBe(appState); // the flow.yaml/audit home moves
    expect(surfaces.launchRoot).toBe(home); // the shell cwd fallback does NOT
  });
});
