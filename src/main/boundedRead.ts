// CWE-59/367/400 — the one bounded, no-follow file read for untrusted on-disk state.

import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isErrno } from './errno';
import { decodeUtf8Strict } from './decodeUtf8Strict';

type BoundedReadFailure = { ok: false; cause: 'absent' | 'over-cap' | 'unreadable'; error?: unknown };
export type BoundedRead = { ok: true; text: string } | BoundedReadFailure;
export type BoundedByteRead = { ok: true; bytes: Buffer } | BoundedReadFailure;

/** Read `file` as UTF-8 through ONE descriptor opened O_NOFOLLOW|O_NONBLOCK: a symlink leaf, a FIFO or other
 *  non-regular file, a file past `maxBytes`, or invalid UTF-8 never yields text. Only a genuine ENOENT is
 *  `absent`. Never throws. */
export function readBoundedNoFollow(file: string, maxBytes: number): BoundedRead {
  const read = readBoundedBytesNoFollow(file, maxBytes);
  if (!read.ok) return read;
  try {
    return { ok: true, text: decodeUtf8Strict(read.bytes) };
  } catch (error) {
    return { ok: false, cause: 'unreadable', error };
  }
}

export function readBoundedBytesNoFollow(file: string, maxBytes: number): BoundedByteRead {
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
    return { ok: true, bytes: buf.subarray(0, total) };
  } catch (e) {
    return { ok: false, cause: 'unreadable', error: e };
  } finally {
    closeSync(fd);
  }
}

/** `readBoundedNoFollow` of `file`'s real path, for a file whose own name may legitimately be a link. */
export function readBoundedResolved(file: string, maxBytes: number): BoundedRead {
  let real: string;
  try {
    real = realpathSync(file);
  } catch (e) {
    return isErrno(e, 'ENOENT') ? { ok: false, cause: 'absent' } : { ok: false, cause: 'unreadable', error: e };
  }
  return readBoundedNoFollow(real, maxBytes);
}

