// Rasterize the source app icon (build/icon.svg) into the PNG electron-builder consumes from
// `buildResources` and the BrowserWindow loads at runtime. electron-builder rejects SVG icons, so
// this is the one place the vector source becomes the committed raster. Chained into `pnpm run
// package`; rasterizes only when build/icon.svg changed since the last run (see generateIcon).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ICON_SIZE = 1024;

/** Content fingerprint of the SVG source — the basis for the up-to-date check. */
export function fingerprint(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Write the PNG only when the SVG content fingerprint differs from the one recorded at hashPath (or
 * the PNG/record is absent). `render(svgBytes) => Buffer` is injected so the up-to-date decision is
 * independent of the rasterizer. Returns whether it rasterized.
 */
export function generateIcon({ svgPath, pngPath, hashPath, render }) {
  const svg = readFileSync(svgPath);
  const fp = fingerprint(svg);
  const upToDate = existsSync(pngPath) && existsSync(hashPath) && readFileSync(hashPath, 'utf8').trim() === fp;
  if (upToDate) return { regenerated: false, fingerprint: fp };
  writeFileSync(pngPath, render(svg));
  writeFileSync(hashPath, fp + '\n');
  return { regenerated: true, fingerprint: fp };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  // Load the native rasterizer only when actually generating, so importing this module (tests) needs
  // neither the @resvg binary nor an install.
  const { Resvg } = await import('@resvg/resvg-js');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = generateIcon({
    svgPath: path.join(root, 'build', 'icon.svg'),
    pngPath: path.join(root, 'build', 'icon.png'),
    hashPath: path.join(root, 'build', 'icon.svg.sha256'),
    render: (svg) => new Resvg(svg, { fitTo: { mode: 'width', value: ICON_SIZE } }).render().asPng(),
  });
  console.log(result.regenerated ? 'gen-icon: wrote build/icon.png' : 'gen-icon: build/icon.svg unchanged, skipped');
}
