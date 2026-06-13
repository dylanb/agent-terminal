import { createTerminalPane } from './terminal';
import { wireSelection } from './selection';
import { wireMonitorPane } from './monitor';
import { wireLayout } from './layout';

const term = createTerminalPane(document.getElementById('terminal')!);
wireSelection(term);
wireMonitorPane();
// Global UI prefs (split ratio) live on the monitor preload namespace (§16.6).
wireLayout(window.monitor);
