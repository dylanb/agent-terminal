import { createControllerPanes } from './controllerPanes';
import { applyDocumentTheme, createControllerClock, createViewportLayout } from './controllerFrame';

const panes = createControllerPanes(document.getElementById('controller')!, {
  controller: window.controller,
  layout: createViewportLayout(window),
  clock: createControllerClock(window),
  applyTheme: theme => applyDocumentTheme(document.documentElement, theme),
});
window.addEventListener('beforeunload', () => panes.dispose());
