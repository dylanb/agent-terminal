import { createTerminalPane } from './terminal';
import { wireSelection } from './selection';
import { wireMonitorPane } from './monitor';
import { createShell } from './shell';
import { wireCrossHighlight } from './crossHighlight';

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
