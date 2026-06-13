// Resolves the app-owned shell-integration script path (§15.5 / D3). electron-vite
// copies the asset to out/main and the asarUnpack query keeps it on disk (not
// inside the asar archive) so bash can `source` it. The path is build-resolved,
// never user-supplied — a foreign shell that lacks the file degrades silently.

import scriptPath from './assets/shell-integration.bash?asset&asarUnpack';

// TODO(dylan): the packaged-app path (asarUnpack keeps the script on disk so bash
// can source it) is only reachable in a real `electron-builder` artifact, not in
// dev/e2e — it's a manual spot-check (§12-style gap, CLAUDE.md exemption):
// `npm run package`, run the artifact, `ls` shows a command-history entry.
export const SHELL_INTEGRATION_SCRIPT: string = scriptPath;
