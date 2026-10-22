import { createControllerPanes } from './controllerPanes';

const panes = createControllerPanes(document.getElementById('controller')!, { controller: window.controller });
window.addEventListener('beforeunload', () => panes.dispose());
