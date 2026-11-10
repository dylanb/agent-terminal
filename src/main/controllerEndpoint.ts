import { join } from 'node:path';

export function resolveControllerEndpoint(appHome: string): string {
  return join(appHome, 'controller', 'socket');
}
