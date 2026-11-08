import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** The build a window and its sessions' servers name on the bridge: the server script's own bytes, so a window
 *  left open across a reinstall never talks to a server from the new build. */
export function mcpBuildId(serverScript: string): string {
  return createHash('sha256').update(readFileSync(serverScript)).digest('hex').slice(0, 32);
}
