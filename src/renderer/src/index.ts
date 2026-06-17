import { createTerminalPane } from './terminal';
import { wireSelection } from './selection';
import { wireMonitorPane } from './monitor';
import { createShell } from './shell';
import { wireCrossHighlight } from './crossHighlight';
import { SAMPLE_FLOW, flowLabel, renderFlow, renderRailStatus, createGatePanel } from './flow';
import { createArtifacts } from './artifacts';
import { renderMarkdownInto, renderCodeInto } from './viewerRender';
import { doInject } from './paneActions';
import { captureToTodo } from './selection';

const term = createTerminalPane(document.getElementById('terminal')!);
wireSelection(term);
wireMonitorPane();

// The converged three-view shell (§24.1C): view switching, hotkeys, the docked
// quick-send drawer, and the theme — with theme persisted through the global
// UI-settings seam (§16.6). The drawer hosts the reused action window; no scrim,
// so the terminal stays visible for cross-highlight (§16.8, §22.2 amendment).
createShell(document.getElementById('app')!, {
  getTheme: () => window.monitor.getSettings().then((s) => s.theme),
  setTheme: (theme) => window.monitor.setSettings({ theme }),
});

// Cross-highlight wiring for any finding/source pairs that carry a data-find id
// (the mocked artifact/finding markup today; real provenance spans in a later phase).
wireCrossHighlight(document.getElementById('app')!);

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
  let repoKey: string | null = null;
  const artifacts = createArtifacts(artifactsHost, {
    loadTree: (scope) => window.viewer.tree(scope),
    loadFile: (relPath) => window.viewer.read(relPath),
    renderMarkdown: renderMarkdownInto,
    renderCode: renderCodeInto,
    send: (text) => doInject(text, false),
    addToTodo: (text) => captureToTodo(window.monitor, repoKey, text),
  });
  window.monitor.onCwdChanged((m) => {
    repoKey = m.repoKey;
    void artifacts.refresh(); // re-discover when the agent cd's into another repo/dir
  });
}
