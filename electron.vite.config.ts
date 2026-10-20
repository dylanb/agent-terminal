import path from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import type { Plugin } from 'vite';
import { copyDevIcon } from './src/main/appIconBuild';
import { copyExampleCodexSkills, copyExampleCommands, copyExampleFlows, copyExampleLoopsV2 } from './src/main/exampleAssetsBuild';
import { ARTIFACT_CHECK_ENTRY } from './src/main/artifactCheck';
import { BENCH_ENTRY } from './src/main/benchMain';

// After the main bundle is written, copy build/icon.png and the example trees next to it so the
// unpackaged runtime resolvers (app.getAppPath()/build/icon.png and .../example/{flows,loops-v2,commands})
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
      copyExampleFlows(rootDir, outDir);
      copyExampleLoopsV2(rootDir, outDir);
      copyExampleCommands(rootDir, outDir);
      copyExampleCodexSkills(rootDir, outDir);
    },
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copyDevAssetsPlugin()], // keeps node-pty (native) and @xterm/headless unbundled
    build: {
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'src/main/index.ts'),
          // §27.12 — the agent-runnable format checker, resolved at runtime by resolveArtifactCheckScript.
          [ARTIFACT_CHECK_ENTRY]: path.resolve(__dirname, 'src/main/artifactCheckMain.ts'),
          // #180 — the bench runner, run by the `bench` script.
          [BENCH_ENTRY]: path.resolve(__dirname, 'src/main/benchMainEntry.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {},
});
