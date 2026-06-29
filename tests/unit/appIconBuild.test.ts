import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { copyDevIcon } from '../../src/main/appIconBuild';
import { resolveWindowIconPath } from '../../src/main/appIcon';

// The unpackaged runtime resolver reads <app.getAppPath()>/build/icon.png, and app.getAppPath() is the
// main out dir for a built (non-packaged) run — but nothing put the icon there, so dock.setIcon failed
// and aborted the window. The build copy must land the committed icon exactly where the resolver reads
// it; reusing the resolver keeps the two from drifting.
describe('copyDevIcon — places the icon where the unpackaged resolver reads it', () => {
  let root: string;
  let out: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'icon-root-'));
    out = mkdtempSync(path.join(tmpdir(), 'icon-out-'));
    mkdirSync(path.join(root, 'build'), { recursive: true });
    writeFileSync(path.join(root, 'build', 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });

  it('copies build/icon.png to the path resolveWindowIconPath reads for that out dir', () => {
    const dest = copyDevIcon(root, out);
    // The destination IS the resolver's unpackaged path for appPath = out — they cannot drift.
    expect(dest).toBe(resolveWindowIconPath({ packaged: false, resourcesPath: '', appPath: out }));
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest)).toEqual(readFileSync(path.join(root, 'build', 'icon.png')));
  });

  it('creates the destination directory if it does not exist yet', () => {
    expect(existsSync(path.join(out, 'build'))).toBe(false);
    copyDevIcon(root, out);
    expect(existsSync(path.join(out, 'build', 'icon.png'))).toBe(true);
  });
});
