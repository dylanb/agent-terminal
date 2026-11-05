import { accessSync, constants, statSync } from 'node:fs';

/** Whether `file` is a regular file this process may read, decided by `stat` and `access` alone: nothing is
 *  opened, so a named pipe cannot block the caller. */
export function isReadableRegularFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
