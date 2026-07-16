import path from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import type { Plugin } from 'vite';
import { copyDevIcon } from './src/main/appIconBuild';
import { copyExampleCommands, copyExampleFlow, copyExampleLoops } from './src/main/exampleAssetsBuild';

// After the main bundle is written, copy build/icon.png and the example trees next to it so the
// unpackaged runtime resolvers (app.getAppPath()/build/icon.png and .../example/{flow,loops,commands})
// find them — without this, dock.setIcon fails on a missing icon and the install-examples action has no
// bundle to seed from.
function copyDevAssetsPlugin(): Plugin {
  let outDir = '';
  return {
    name: 'copy-dev-assets',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      if (!outDir) return;
      const rootDir = path.resolve(outDir, '..', '..');
      copyDevIcon(rootDir, outDir);
      copyExampleFlow(rootDir, outDir);
      copyExampleLoops(rootDir, outDir);
      copyExampleCommands(rootDir, outDir);
    },
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copyDevAssetsPlugin()], // keeps node-pty (native) and @xterm/headless unbundled
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {},
});
