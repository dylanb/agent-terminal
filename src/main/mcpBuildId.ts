import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function mcpBuildId(serverScript: string): string {
  return createHash('sha256').update(readFileSync(serverScript)).digest('hex').slice(0, 32);
}
