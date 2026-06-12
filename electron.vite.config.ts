import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()], // keeps node-pty (native) and @xterm/headless unbundled
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {},
});
