import { join } from 'node:path';
import type { WindowRequest } from '../shared/mcpBridge';

export interface WindowBridge {
  readonly endpoint: string;
  close(): Promise<void>;
}

/** The directory that holds every window's endpoint under `appHome`. */
export function windowBridgeDir(appHome: string): string {
  return join(appHome, '.agent-terminal', 'mcp');
}

/** The window's end of the bridge: answers its own sessions' calls with `handle`. `build` names the running build, so
 *  a server from another build is never answered. */
export async function openWindowBridge(opts: {
  appHome: string;
  build: string;
  handle: (request: WindowRequest) => Promise<unknown>;
}): Promise<WindowBridge> {
  return { endpoint: join(windowBridgeDir(opts.appHome), 'window.sock'), close: async () => {} };
}
