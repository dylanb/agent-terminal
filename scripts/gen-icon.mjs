// Rasterize the source app icon (build/icon.svg) into the PNG electron-builder consumes from
// `buildResources` and the BrowserWindow loads at runtime. electron-builder rejects SVG icons, so
// this is the one place the vector source becomes the committed raster. Run via `npm run gen-icon`
// after editing build/icon.svg.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';

const ICON_SIZE = 1024;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(path.join(root, 'build', 'icon.svg'));
const png = new Resvg(svg, { fitTo: { mode: 'width', value: ICON_SIZE } }).render().asPng();
const out = path.join(root, 'build', 'icon.png');
writeFileSync(out, png);
console.log(`wrote ${out} (${ICON_SIZE}x${ICON_SIZE}, ${png.length} bytes)`);
