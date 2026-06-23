import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveWindowIconPath, resolveDockIconPath } from '../../src/main/appIcon';

// The runtime BrowserWindow icon. Packaged builds get the PNG copied beside the asar via
// electron-builder `extraResources`; in dev it sits at <appPath>/build/icon.png (the same asset
// electron-builder consumes from `buildResources` to mint the installer icons).
describe('resolveWindowIconPath', () => {
  it('resolves to the extraResources copy in a packaged app', () => {
    expect(
      resolveWindowIconPath({ packaged: true, resourcesPath: '/app/resources', appPath: '/app/app.asar' }),
    ).toBe(path.join('/app/resources', 'icon.png'));
  });

  it('resolves to build/icon.png under the project root in dev', () => {
    expect(
      resolveWindowIconPath({ packaged: false, resourcesPath: '/ignored', appPath: '/project' }),
    ).toBe(path.join('/project', 'build', 'icon.png'));
  });
});

// macOS draws the Dock / CMD-TAB icon from the app bundle's .icns (or app.dock.setIcon at runtime),
// NOT from BrowserWindow.icon — so the dock icon is set only on darwin. Off darwin app.dock does not
// exist; resolving null keeps index.ts from calling it.
describe('resolveDockIconPath', () => {
  it('resolves to the window icon path on darwin (packaged)', () => {
    expect(
      resolveDockIconPath('darwin', { packaged: true, resourcesPath: '/app/resources', appPath: '/app/app.asar' }),
    ).toBe(path.join('/app/resources', 'icon.png'));
  });

  it('resolves to build/icon.png on darwin in dev', () => {
    expect(
      resolveDockIconPath('darwin', { packaged: false, resourcesPath: '/ignored', appPath: '/project' }),
    ).toBe(path.join('/project', 'build', 'icon.png'));
  });

  it('resolves to null off darwin', () => {
    const loc = { packaged: false, resourcesPath: '/r', appPath: '/p' };
    expect(resolveDockIconPath('linux', loc)).toBeNull();
    expect(resolveDockIconPath('win32', loc)).toBeNull();
  });
});

// The wired asset must actually exist and be a valid 1024×1024 PNG — otherwise the resolver points at
// nothing and the window/installer silently fall back to the default Electron icon.
describe('committed build/icon.png', () => {
  const root = path.resolve(__dirname, '..', '..');
  const png = readFileSync(resolveWindowIconPath({ packaged: false, resourcesPath: '', appPath: root }));

  it('starts with the PNG signature', () => {
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  it('is 1024×1024 (IHDR width/height)', () => {
    // PNG IHDR: 8-byte signature, 4-byte length, 4-byte "IHDR", then width(4) + height(4) big-endian.
    expect(png.readUInt32BE(16)).toBe(1024);
    expect(png.readUInt32BE(20)).toBe(1024);
  });
});
