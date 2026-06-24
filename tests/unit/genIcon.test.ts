import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error — JS build script, no type declarations.
import { generateIcon, fingerprint } from '../../scripts/gen-icon.mjs';

const RASTER = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), 'genicon-'));

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

// Drift guard: the committed build/icon.svg.sha256 is what generateIcon compares against to decide
// whether the committed PNG is up to date. If a hand-edited SVG is committed without re-running the
// generator, the recorded fingerprint no longer matches the source and the shipped PNG is stale —
// undetectable in review. Binding the record to the source here fails the suite when they desync.
describe('committed icon artifacts', () => {
  const buildDir = path.resolve(__dirname, '..', '..', 'build');

  it('records a sha256 that matches the committed build/icon.svg', () => {
    const svg = readFileSync(path.join(buildDir, 'icon.svg'));
    const recorded = readFileSync(path.join(buildDir, 'icon.svg.sha256'), 'utf8').trim();
    expect(recorded).toBe(fingerprint(svg));
  });
});

// Wiring guard: `pnpm run package` must invoke the generator so a packaged build can never ship a
// stale icon. The generator self-skips when the SVG is unchanged, so the chain is cheap.
describe('package script wiring', () => {
  it('runs gen-icon before electron-builder', () => {
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8'));
    const script = pkg.scripts.package as string;
    expect(script).toContain('gen-icon');
    expect(script.indexOf('gen-icon')).toBeLessThan(script.indexOf('electron-builder'));
  });
});
