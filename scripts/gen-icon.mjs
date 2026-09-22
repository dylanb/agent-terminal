// electron-builder and BrowserWindow reject SVG icons, so build/icon.svg is rasterized to the PNG
// they consume.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ICON_SIZE = 1024;

export function fingerprint(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * `render(svgBytes) => Buffer` is injected so the up-to-date decision is independent of the
 * rasterizer. Returns whether it rasterized.
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

// untestable in CI: the @resvg render below runs only at package, and build/icon.png is guarded by hash +
// dimensions, not byte-equality to the render (resvg output is non-deterministic) — §12 gap tracked in #153.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
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
