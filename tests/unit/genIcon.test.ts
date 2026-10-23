import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error — JS build script, no type declarations.
import { generateIcon, fingerprint } from '../../scripts/gen-icon.mjs';

const RASTER = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const tmpDirs: string[] = [];
const tmp = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'genicon-'));
  tmpDirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('generateIcon', () => {
  const paths = (dir: string): { svgPath: string; pngPath: string; hashPath: string } => ({
    svgPath: path.join(dir, 'icon.svg'),
    pngPath: path.join(dir, 'icon.png'),
    hashPath: path.join(dir, 'icon.svg.sha256'),
  });

  it('rasterizes and records the fingerprint when nothing has been generated yet', () => {
    const dir = tmp();
    const p = paths(dir);
    writeFileSync(p.svgPath, '<svg>a</svg>');
    const render = vi.fn(() => RASTER);

    const result = generateIcon({ ...p, render });

    expect(result.regenerated).toBe(true);
    expect(render).toHaveBeenCalledTimes(1);
    expect(readFileSync(p.pngPath)).toEqual(RASTER);
    expect(readFileSync(p.hashPath, 'utf8').trim()).toBe(fingerprint(Buffer.from('<svg>a</svg>')));
  });

  it('skips rasterizing when the SVG content is unchanged', () => {
    const dir = tmp();
    const p = paths(dir);
    writeFileSync(p.svgPath, '<svg>a</svg>');
    generateIcon({ ...p, render: () => RASTER });
    const pngMtime = statSync(p.pngPath).mtimeMs;
    const render = vi.fn(() => Buffer.from([0xff]));

    const result = generateIcon({ ...p, render });

    expect(result.regenerated).toBe(false);
    expect(render).not.toHaveBeenCalled();
    expect(statSync(p.pngPath).mtimeMs).toBe(pngMtime);
  });

  it('re-rasterizes when the PNG is missing even though the recorded fingerprint still matches', () => {
    const dir = tmp();
    const p = paths(dir);
    writeFileSync(p.svgPath, '<svg>a</svg>');
    generateIcon({ ...p, render: () => RASTER });
    rmSync(p.pngPath);
    const render = vi.fn(() => RASTER);

    const result = generateIcon({ ...p, render });

    expect(result.regenerated).toBe(true);
    expect(render).toHaveBeenCalledTimes(1);
    expect(readFileSync(p.pngPath)).toEqual(RASTER);
  });

  it('re-rasterizes when the hash record is missing even though the PNG is present', () => {
    const dir = tmp();
    const p = paths(dir);
    writeFileSync(p.svgPath, '<svg>a</svg>');
    generateIcon({ ...p, render: () => RASTER });
    rmSync(p.hashPath);
    const render = vi.fn(() => RASTER);

    const result = generateIcon({ ...p, render });

    expect(result.regenerated).toBe(true);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('re-rasterizes when the SVG content changes', () => {
    const dir = tmp();
    const p = paths(dir);
    writeFileSync(p.svgPath, '<svg>a</svg>');
    generateIcon({ ...p, render: () => RASTER });
    writeFileSync(p.svgPath, '<svg>b</svg>');
    const next = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x42]);
    const render = vi.fn(() => next);

    const result = generateIcon({ ...p, render });

    expect(result.regenerated).toBe(true);
    expect(render).toHaveBeenCalledTimes(1);
    expect(readFileSync(p.pngPath)).toEqual(next);
    expect(readFileSync(p.hashPath, 'utf8').trim()).toBe(fingerprint(Buffer.from('<svg>b</svg>')));
  });
});

describe('committed icon artifacts', () => {
  const buildDir = path.resolve(__dirname, '..', '..', 'build');

  it('records a build/icon.svg.sha256 that matches the committed build/icon.svg', () => {
    const svg = readFileSync(path.join(buildDir, 'icon.svg'));
    const recorded = readFileSync(path.join(buildDir, 'icon.svg.sha256'), 'utf8').trim();
    expect(recorded).toBe(fingerprint(svg));
  });

  it('records a build/controller-icon.svg.sha256 that matches the committed build/controller-icon.svg', () => {
    const svg = readFileSync(path.join(buildDir, 'controller-icon.svg'));
    const recorded = readFileSync(path.join(buildDir, 'controller-icon.svg.sha256'), 'utf8').trim();
    expect(recorded).toBe(fingerprint(svg));
  });
});

describe('package script wiring', () => {
  it('runs gen-icon before electron-builder', () => {
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8'));
    const script = pkg.scripts.package as string;
    expect(script).toContain('gen-icon');
    expect(script.indexOf('gen-icon')).toBeLessThan(script.indexOf('electron-builder'));
  });

  it('packages the controller as well as the terminal, after the shared build', () => {
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8'));
    const steps = (pkg.scripts.package as string).split('&&').map(step => step.trim());
    const controller = steps.indexOf('electron-builder --config electron-builder.controller.yml');
    expect(steps).toContain('electron-builder');
    expect(controller).toBeGreaterThan(steps.indexOf('pnpm run build'));
  });
});
