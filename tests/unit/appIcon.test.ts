import { describe, it, expect, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { getConfig } from 'app-builder-lib/out/util/config/config';
import { resolveWindowIconPath, resolveDockIconPath, applyDockIcon, type IconLocation } from '../../src/main/appIcon';
import { controllerTrayIcon, type TrayBadge } from '../../src/main/controllerTrayModel';

describe('resolveWindowIconPath', () => {
  it('resolves to the extraResources copy in a packaged app', () => {
    expect(
      resolveWindowIconPath({ packaged: true, resourcesPath: '/app/resources' }, 'terminal'),
    ).toBe(path.join('/app/resources', 'icon.png'));
  });

  it('resolves to build/icon.png under the project root in dev', () => {
    expect(
      resolveWindowIconPath({ packaged: false, appPath: '/project' }, 'terminal'),
    ).toBe(path.join('/project', 'build', 'icon.png'));
  });
});

describe('resolveWindowIconPath — the controller has its own icon', () => {
  it('resolves to its own extraResources copy in a packaged controller', () => {
    expect(
      resolveWindowIconPath({ packaged: true, resourcesPath: '/app/resources' }, 'controller'),
    ).toBe(path.join('/app/resources', 'controller-icon.png'));
  });

  it('resolves to build/controller-icon.png under the project root in dev', () => {
    expect(
      resolveWindowIconPath({ packaged: false, appPath: '/project' }, 'controller'),
    ).toBe(path.join('/project', 'build', 'controller-icon.png'));
  });

  it('sets the controller Dock icon on darwin', () => {
    const dock = { setIcon: vi.fn() };
    applyDockIcon(dock, 'darwin', { packaged: false, appPath: '/project' }, 'controller');
    expect(dock.setIcon).toHaveBeenCalledWith(path.join('/project', 'build', 'controller-icon.png'));
  });
});

describe('resolveDockIconPath', () => {
  it('resolves to the window icon path on darwin (packaged)', () => {
    expect(
      resolveDockIconPath('darwin', { packaged: true, resourcesPath: '/app/resources' }, 'terminal'),
    ).toBe(path.join('/app/resources', 'icon.png'));
  });

  it('resolves to build/icon.png on darwin in dev', () => {
    expect(
      resolveDockIconPath('darwin', { packaged: false, appPath: '/project' }, 'terminal'),
    ).toBe(path.join('/project', 'build', 'icon.png'));
  });

  it('resolves to null off darwin', () => {
    const loc: IconLocation = { packaged: false, appPath: '/p' };
    expect(resolveDockIconPath('linux', loc, 'terminal')).toBeNull();
    expect(resolveDockIconPath('win32', loc, 'terminal')).toBeNull();
  });
});

describe('applyDockIcon', () => {
  const darwin: IconLocation = { packaged: false, appPath: '/project' };

  it('sets the Dock icon to the resolved path on darwin', () => {
    const dock = { setIcon: vi.fn() };
    applyDockIcon(dock, 'darwin', darwin, 'terminal');
    expect(dock.setIcon).toHaveBeenCalledWith(path.join('/project', 'build', 'icon.png'));
  });

  it('does not touch the Dock off darwin', () => {
    const dock = { setIcon: vi.fn() };
    applyDockIcon(dock, 'linux', darwin, 'terminal');
    expect(dock.setIcon).not.toHaveBeenCalled();
  });

  it('is a no-op when app.dock is absent (off darwin, no Dock object)', () => {
    expect(() => applyDockIcon(undefined, 'win32', darwin, 'terminal')).not.toThrow();
  });

  it('is a no-op on darwin when app.dock is unexpectedly absent (does not throw)', () => {
    expect(() => applyDockIcon(undefined, 'darwin', darwin, 'terminal')).not.toThrow();
  });

  it('swallows a setIcon failure so a missing/bad icon never aborts window creation', () => {
    // Electron's dock.setIcon throws synchronously on an unreadable image path; since applyDockIcon
    // runs inside async createWindow BEFORE `new BrowserWindow`, an uncaught throw here would abort the
    // whole window. A cosmetic Dock icon must never do that.
    const dock = {
      setIcon: vi.fn(() => {
        throw new Error('Failed to load image from path');
      }),
    };
    expect(() => applyDockIcon(dock, 'darwin', darwin, 'terminal')).not.toThrow();
    expect(dock.setIcon).toHaveBeenCalled();
  });
});

describe('extraResources packaged-path coupling', () => {
  const root = path.resolve(__dirname, '..', '..');
  const builderYml = readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');

  it('ships the PNG under the basename the packaged resolver reads back', () => {
    const basename = path.basename(
      resolveWindowIconPath({ packaged: true, resourcesPath: '/app/resources' }, 'terminal'),
    );
    // Coupling: renaming either the electron-builder `to:` target or the packaged resolver basename
    // breaks the runtime icon, and no type catches it — this test is the guard.
    expect(builderYml).toMatch(new RegExp(`to:\\s*${basename}\\b`));
    expect(builderYml).toMatch(/from:\s*build\/icon\.png\b/);
  });
});

describe('committed build/icon.png', () => {
  const root = path.resolve(__dirname, '..', '..');
  const png = readFileSync(resolveWindowIconPath({ packaged: false, appPath: root }, 'terminal'));

  it('starts with the PNG signature', () => {
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  it('is 1024×1024 (IHDR width/height)', () => {
    const IHDR_WIDTH_OFFSET = 16;
    const IHDR_HEIGHT_OFFSET = 20;
    expect(png.readUInt32BE(IHDR_WIDTH_OFFSET)).toBe(1024);
    expect(png.readUInt32BE(IHDR_HEIGHT_OFFSET)).toBe(1024);
  });
});

describe('committed controller icon', () => {
  const root = path.resolve(__dirname, '..', '..');
  const png = readFileSync(resolveWindowIconPath({ packaged: false, appPath: root }, 'controller'));

  it('is a 1024×1024 PNG', () => {
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.readUInt32BE(16)).toBe(1024);
    expect(png.readUInt32BE(20)).toBe(1024);
  });
});

describe('packaged controller icon (electron-builder merged config)', () => {
  const root = path.resolve(__dirname, '..', '..');
  const source = path.relative(root, resolveWindowIconPath({ packaged: false, appPath: root }, 'controller'));
  const shipped = path.basename(resolveWindowIconPath({ packaged: true, resourcesPath: '/app/resources' }, 'controller'));
  const load = (file: string) => getConfig(root, file, null);

  it('uses the controller icon as the macOS and Linux application icon', async () => {
    const config = await load('electron-builder.controller.yml');
    expect(config.mac?.icon).toBe(source);
    expect(config.linux?.icon).toBe(source);
  });

  it('ships the controller icon under the basename the packaged resolver reads back', async () => {
    const config = await load('electron-builder.controller.yml');
    expect(config.extraResources).toContainEqual({ from: source, to: shipped });
  });

  it('ships each tray icon under the basename the packaged resolver reads back', async () => {
    const config = await load('electron-builder.controller.yml');
    const shipped = TRAY_BADGES.map(controllerTrayIcon).map(icon => ({
      from: path.relative(root, resolveWindowIconPath({ packaged: false, appPath: root }, icon)),
      to: path.basename(resolveWindowIconPath({ packaged: true, resourcesPath: '/app/resources' }, icon)),
    }));
    expect(config.extraResources).toEqual(expect.arrayContaining(shipped));
  });

  it('leaves the terminal package on its own icon', async () => {
    const config = await load('electron-builder.yml');
    expect(config.mac?.icon).toBeUndefined();
    expect(config.linux?.icon).toBeUndefined();
    expect(config.extraResources).not.toContainEqual({ from: source, to: shipped });
  });
});

const TRAY_BADGES: TrayBadge[] = ['none', 'needs-human', 'error'];

describe('committed tray icons', () => {
  it('has a PNG for every tray badge where the unpackaged controller reads it', () => {
    const root = path.resolve(__dirname, '..', '..');
    const notPng = TRAY_BADGES.map(controllerTrayIcon).filter(icon => {
      const file = resolveWindowIconPath({ packaged: false, appPath: root }, icon);
      return !existsSync(file) || !readFileSync(file).subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    });
    expect(notPng).toEqual([]);
  });
});
