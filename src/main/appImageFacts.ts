import fs from 'node:fs';
import path from 'node:path';
import type { AppImageFacts } from './cliShim';

function realOrGiven(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** Linux's `process.execPath` is symlink-resolved but the AppImage runtime's `APPDIR` is not, so an absolute
 *  `APPDIR` is resolved here; a relative one stays relative so `resolveLaunchInvocation` refuses it. */
export function appImageFactsFromEnv(env: NodeJS.ProcessEnv): AppImageFacts | undefined {
  const { APPIMAGE: appImage, APPDIR: mountDir } = env;
  if (!appImage || !mountDir) return undefined;
  return { appImage, mountDir: path.isAbsolute(mountDir) ? realOrGiven(mountDir) : mountDir };
}
