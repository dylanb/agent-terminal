import path from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import type { Plugin } from 'vite';
import { copyDevIcon } from './src/main/appIconBuild';

// After the main bundle is written, copy build/icon.png next to it so the unpackaged runtime resolver
// (app.getAppPath()/build/icon.png) finds it — without this, dock.setIcon fails on a missing icon.
function copyDevIconPlugin(): Plugin {
  let outDir = '';
  return {
    name: 'copy-dev-icon',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      if (outDir) copyDevIcon(path.resolve(outDir, '..', '..'), outDir);
    },
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copyDevIconPlugin()], // keeps node-pty (native) and @xterm/headless unbundled
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {},
});
