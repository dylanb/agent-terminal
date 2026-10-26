import { createControllerPanes } from './controllerPanes';
import { applyDocumentTheme, createViewportLayout } from './controllerFrame';

const panes = createControllerPanes(document.getElementById('controller')!, {
  controller: window.controller,
  layout: createViewportLayout(window),
  applyTheme: theme => applyDocumentTheme(document.documentElement, theme),
});
window.addEventListener('beforeunload', () => panes.dispose());
