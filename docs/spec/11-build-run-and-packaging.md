## 11. Build, run, and packaging

The repo uses **pnpm** (`packageManager` in `package.json`). `.npmrc` pins `node-linker=hoisted` so `@electron/rebuild` and electron-builder see a flat `node_modules`, and `pnpm.onlyBuiltDependencies` allows node-pty/electron/esbuild to run install scripts (pnpm v10 blocks build scripts by default).

### Dependencies
```
pnpm add @xterm/xterm @xterm/headless @xterm/addon-fit node-pty
pnpm add -D electron electron-builder @electron/rebuild
```
(Pin `@xterm/xterm` and `@xterm/headless` to the same version — §8.2.)

### The native-module gotcha
`node-pty` is a native addon and must be compiled against **Electron's** Node ABI, not the system Node. After install (and after any Electron version bump), run:
```
pnpm exec electron-rebuild -f -w node-pty
```
electron-builder triggers this during packaging; for `electron .` dev runs you must do it manually once.

### Run (dev)
```
pnpm run rebuild   # electron-rebuild for node-pty (also runs on postinstall)
pnpm run dev       # electron-vite dev (renderer HMR)
```

### Package
`electron-builder` targets: macOS `dmg`/`zip` and Linux `AppImage`/`deb`. Note that `node-pty` ships as a native binary per platform, so build on (or cross-build for) each target OS.

---


## Separate controller packaging (#217)

The build includes `out/main/controller.js` and its renderer alongside the independent terminal entry. `electron-builder.controller.yml` derives the existing packaging configuration with its own application identity and output directory. `pnpm run package` builds the terminal and then the controller. Installed apps resolve bundled preload, renderer and runtime resources without a checkout. README documents installed/development launch order, Ubuntu-only Linux support verification and the operator-accepted native macOS GUI verification gap.

Initial terminal startup requires a confirmed connection to the separate controller (§23.6). Either application may launch first: the terminal presents instructions and retries automatically until a compatible controller accepts it. The packages update independently; §23.6 versions the controller protocol.
