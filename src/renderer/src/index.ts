import { createTerminalPane } from './terminal';
import { wireSelection } from './selection';
import { wireMonitorPane } from './monitor';
import { createShell } from './shell';
import { SAMPLE_FLOW, flowLabel, renderFlow, renderRailStatus, createGatePanel } from './flow';
import { createArtifacts, type Artifacts } from './artifacts';
import { renderMarkdownInto, renderCodeInto } from './viewerRender';
import { doInject } from './paneActions';
import { captureToTodo } from './selection';
import { createRepoContext } from './repoContext';

const term = createTerminalPane(document.getElementById('terminal')!);
// One shared OSC-7 repo provider (§16.3): seeds the repo key once and feeds the terminal
// selection capture, the todo list, and the artifact viewer — so no consumer re-derives it.
const repo = createRepoContext(window.monitor);
wireSelection(term, repo);
wireMonitorPane(repo);

// The converged three-view shell (§24.1C): view switching, hotkeys, the docked
// quick-send drawer, and the theme — with theme persisted through the global
// UI-settings seam (§16.6). The drawer hosts the reused action window; no scrim,
// so the terminal stays visible for cross-highlight (§16.8, §22.2 amendment).
// Forward ref so the shell can drive the viewer's full-screen presentation (§20.2) without
// reaching across organisms — the composition root wires the contract both ways.
let artifacts: Artifacts | undefined;
const shell = createShell(document.getElementById('app')!, {
  getTheme: () => window.monitor.getSettings().then((s) => s.theme),
  setTheme: (theme) => window.monitor.setSettings({ theme }),
  onViewerFullscreenChange: (on) => artifacts?.setFullscreen(on),
});

// Mocked flow widgets (§24.1 / §19.2–§19.3): one fixture flow-state drives the rail
// timeline + status and the view-3 gate. Gate actions are stubbed (no loop injection).
const flowLabelEl = document.getElementById('flow-label');
if (flowLabelEl) flowLabelEl.textContent = `Flow — ${flowLabel(SAMPLE_FLOW.steps)}`;
const flowRail = document.getElementById('flow-rail');
if (flowRail) renderFlow(flowRail, SAMPLE_FLOW.steps);
const railStatus = document.getElementById('rail-flowstatus');
if (railStatus) renderRailStatus(railStatus, SAMPLE_FLOW);
const gatePanel = document.getElementById('gate-panel');
if (gatePanel) createGatePanel(gatePanel, SAMPLE_FLOW);

// View 2 — the artifact viewer (§20.2 / §24.1): a fixture artifact set rendered with the
// real markdown-it+mermaid / CodeMirror stack; a selection routes to the same two sinks as
// the terminal-pane selection — send-to-agent (inject, no submit, §9.3) and add-to-todo
// (§16.2). Real discovery + provenance (`viewer:tree`) stays in the §24.2 backlog.
const artifactsHost = document.getElementById('artifacts');
if (artifactsHost) {
  const view = createArtifacts(artifactsHost, {
    loadTree: (scope) => window.viewer.tree(scope),
    loadFile: (relPath) => window.viewer.read(relPath),
    renderMarkdown: renderMarkdownInto,
    renderCode: renderCodeInto,
    send: (text) => doInject(text, false),
    addToTodo: (text) => captureToTodo(window.monitor, repo.repoKey(), text),
    onWidthChange: (px) => window.monitor.setSettings({ artifactTreeWidth: px }),
    onFullscreenWidthChange: (px) => window.monitor.setSettings({ artifactFullscreenTreeWidth: px }),
    onRequestFullscreen: (on) => shell.setViewerFullscreen(on),
  });
  artifacts = view;
  // Re-discover when the agent cd's into another repo/dir (the shared context already holds
  // the seeded key for add-to-todo).
  repo.onChange(() => void view.refresh());
  // Apply the persisted tree width once settings resolve (kept off the sync path above so a
  // late getSettings can't make the viewer miss the first cwd:changed broadcast, §20.1).
  void window.monitor.getSettings().then((s) => {
    view.setWidth(s.artifactTreeWidth);
    if (s.artifactFullscreenTreeWidth !== undefined) view.setFullscreenWidth(s.artifactFullscreenTreeWidth);
  });
}
