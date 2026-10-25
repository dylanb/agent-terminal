import { createControllerPanes } from './controllerPanes';
import { createViewportLayout } from './controllerFrame';

const panes = createControllerPanes(document.getElementById('controller')!, { controller: window.controller, layout: createViewportLayout(window) });
window.addEventListener('beforeunload', () => panes.dispose());
