// CWE-59/367/400 — the one bounded, no-follow file read for untrusted on-disk state.

import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isErrno } from './errno';
import { decodeUtf8Strict } from './decodeUtf8Strict';

export type BoundedRead =
  | { ok: true; text: string }
  | { ok: false; cause: 'absent' | 'over-cap' | 'unreadable'; error?: unknown };

/** Read `file` as UTF-8 through ONE descriptor opened O_NOFOLLOW|O_NONBLOCK: a symlink leaf, a FIFO or other
 *  non-regular file, a file past `maxBytes`, or invalid UTF-8 never yields text. Only a genuine ENOENT is
 *  `absent`. Never throws. */
export function readBoundedNoFollow(file: string, maxBytes: number): BoundedRead {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    return isErrno(e, 'ENOENT') ? { ok: false, cause: 'absent' } : { ok: false, cause: 'unreadable', error: e };
  }
  try {
    if (!fstatSync(fd).isFile()) return { ok: false, cause: 'unreadable' };
    const buf = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total < buf.length) {
      const n = readSync(fd, buf, total, buf.length - total, total);
      if (n === 0) break;
      total += n;
    }
    if (total > maxBytes) return { ok: false, cause: 'over-cap' };
    return { ok: true, text: decodeUtf8Strict(buf.subarray(0, total)) };
  } catch (e) {
    return { ok: false, cause: 'unreadable', error: e };
  } finally {
    closeSync(fd);
  }
}
