import path from 'node:path';
import { defineConfig } from 'vite';

// outDir stays outside out/main, out/preload and out/renderer: the e2e container's `pnpm run build`
// empties those while the proof runs.
export default defineConfig({
  ssr: { noExternal: true },
  build: {
    ssr: path.resolve(__dirname, 'src/main/testProofMain.ts'),
    outDir: path.resolve(__dirname, 'out/test-proof'),
    emptyOutDir: true,
    target: 'node22',
    rollupOptions: { output: { format: 'cjs', entryFileNames: 'testProof.cjs' } },
  },
});
