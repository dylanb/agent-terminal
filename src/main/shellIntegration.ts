// App-owned shell-integration script path (§15.5 / D3). The asarUnpack query keeps the
// asset on disk (outside the asar archive) so bash can `source` it. Build-resolved, never
// user-supplied — a foreign shell that lacks the file degrades silently.

import scriptPath from './assets/shell-integration.bash?asset&asarUnpack';

export const SHELL_INTEGRATION_SCRIPT: string = scriptPath;
