// App-owned shell-integration script path (§15.5 / D3). The asarUnpack query keeps the
// asset on disk (outside the asar archive) so bash can `source` it. Build-resolved, never
// user-supplied — a foreign shell that lacks the file degrades silently.

import scriptPath from './assets/shell-integration.bash?asset&asarUnpack';

// untestable outside a packaged electron-builder artifact (the asarUnpack on-disk source path is reachable
// only there) — manual spot-check only; §12 gap tracked in #153.
export const SHELL_INTEGRATION_SCRIPT: string = scriptPath;
