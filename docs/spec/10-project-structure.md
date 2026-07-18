## 10. Project structure

Built with **electron-vite** (TypeScript, `strict`), three tsconfig projects (main/preload share the node project; renderer is the web project). The IPC contract is a shared module both sides import.

```
agent-terminal/
├── package.json
├── electron.vite.config.ts
├── src/
│   ├── main/            # window + node-pty lifecycle + shadow terminal + IPC + injection API (§5, §8, §9.3)
│   │   ├── index.ts     # window, IPC wiring, output gate, navigation guards
│   │   ├── pty.ts  shadow.ts  quiescence.ts  inject.ts  eventStore.ts
│   │   ├── outputGate.ts  sessionIpc.ts  ipcValidation.ts  rendererTarget.ts  windowGuards.ts
│   │   ├── scanner.ts  commandTracker.ts  extraction.ts  spanTypes.ts  runtimeConfig.ts  shellIntegration.ts  findings.ts  # §15
│   │   ├── adapters/    # types.ts, claudeCode.ts, generic.ts — per-agent semantic detection (§15.3)
│   │   └── assets/      # shell-integration.bash — sourced PROMPT_COMMAND OSC-133 marks (§15.5)
│   ├── preload/index.ts # contextBridge: term + monitor namespaces (§6)
│   ├── renderer/
│   │   ├── index.html   # two-pane layout: <main> #terminal | <aside> #monitor (status, blocks)
│   │   └── src/         # terminal.ts, selection.ts, selectionModel.ts, monitor.ts, styles.css (§7, §9)
│   └── shared/ipc.ts    # the typed IPC contract — single source of truth (§6)
├── tests/               # unit + integration (vitest) + e2e (playwright _electron)
└── out/ , dist/         # electron-vite build + electron-builder output
```

**Minimal `index.html` layout**
```html
<div id="app">
  <div id="terminal-pane">
    <div id="terminal"></div>
  </div>
  <div id="monitor">
    <div id="monitor-status"></div>
    <div id="monitor-blocks"></div>
  </div>
</div>
```
CSS: panes side by side via flex; `#terminal` fills its pane's remaining height and stays sized to whole character cells so `FitAddon` reflows cleanly; the monitor pane scrolls independently.

---

