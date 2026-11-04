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

/** Whether `file` exists and is neither a regular file nor a directory: a named pipe or a device, which a
 *  read can block on, or never finish. */
export function isSpecialFile(file: string): boolean {
  try {
    const st = statSync(file);
    return !st.isFile() && !st.isDirectory();
  } catch {
    return false;
  }
}
