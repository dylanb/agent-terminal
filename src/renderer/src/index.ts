import { createTerminalPane } from './terminal';
import { wireSelection } from './selection';
import { wireMonitorPane } from './monitor';
import { createShell } from './shell';
import { wireCrossHighlight } from './crossHighlight';
import { SAMPLE_FLOW, flowLabel, renderFlow, renderRailStatus, createGatePanel } from './flow';

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
