import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveWindowIconPath, resolveDockIconPath, applyDockIcon } from '../../src/main/appIcon';

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

describe('applyDockIcon', () => {
  const darwin = { packaged: false, resourcesPath: '/ignored', appPath: '/project' };

  it('sets the Dock icon to the resolved path on darwin', () => {
    const dock = { setIcon: vi.fn() };
    applyDockIcon(dock, 'darwin', darwin);
    expect(dock.setIcon).toHaveBeenCalledWith(path.join('/project', 'build', 'icon.png'));
  });

  it('does not touch the Dock off darwin', () => {
    const dock = { setIcon: vi.fn() };
    applyDockIcon(dock, 'linux', darwin);
    expect(dock.setIcon).not.toHaveBeenCalled();
  });

  it('is a no-op when app.dock is absent (off darwin, no Dock object)', () => {
    expect(() => applyDockIcon(undefined, 'win32', darwin)).not.toThrow();
  });

  it('is a no-op on darwin when app.dock is unexpectedly absent (does not throw)', () => {
    expect(() => applyDockIcon(undefined, 'darwin', darwin)).not.toThrow();
  });
});

describe('extraResources packaged-path coupling', () => {
  const root = path.resolve(__dirname, '..', '..');
  const builderYml = readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');

  it('ships the PNG under the basename the packaged resolver reads back', () => {
    const basename = path.basename(
      resolveWindowIconPath({ packaged: true, resourcesPath: '/app/resources', appPath: '/app/app.asar' }),
    );
    // Coupling: renaming either the electron-builder `to:` target or the packaged resolver basename
    // breaks the runtime icon, and no type catches it — this test is the guard.
    expect(builderYml).toMatch(new RegExp(`to:\\s*${basename}\\b`));
    expect(builderYml).toMatch(/from:\s*build\/icon\.png\b/);
  });
});

describe('committed build/icon.png', () => {
  const root = path.resolve(__dirname, '..', '..');
  const png = readFileSync(resolveWindowIconPath({ packaged: false, resourcesPath: '', appPath: root }));

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
