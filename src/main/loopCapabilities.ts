// §28.5.4 — the main-process READER for `loop-capabilities.yaml`. The engine NEVER executes
// test_command/build_command: they are inert guidance strings, only parsed and shape-validated. The file lives
// in the untrusted repo working tree, so it is confined before reading (resolveJail, CWE-22/59) and read
// fail-closed. The descriptor/shape/parse predicate is single-sourced in src/shared/loopCapabilities.ts (#105).

import { openSync, fstatSync, readSync, closeSync, constants } from 'node:fs';
import { isErrno, errMsg } from './errno';
import { resolveJail } from './confinedPath';
import { decodeUtf8Strict } from './decodeUtf8Strict';
import {
  LOOP_CAPABILITIES_FILENAME,
  MAX_CAPABILITIES_BYTES,
  parseLoopCapabilities,
  type LoopCapabilities,
} from '../shared/loopCapabilities';

// Re-export the shared descriptor so main-process callers have one import site; the DEFINITION lives in shared.
export {
  LOOP_CAPABILITIES_FILENAME,
  MAX_CAPABILITIES_BYTES,
  parseLoopCapabilities,
} from '../shared/loopCapabilities';
export type { LoopCapabilities, LoopCapabilitiesParse } from '../shared/loopCapabilities';

/** The load failure arm carries a discriminated `cause` (mirroring confinedPath's `PathRefusal`) so a
 *  consumer (S3/S4) branches on the kind — absent → degrade coherently (§28.5.6); malformed → human-owned
 *  error; confinement → a security refusal — never by substring-matching the human `reason`. */
export type LoopCapabilitiesLoad =
  | { ok: true; value: LoopCapabilities }
  | { ok: false; cause: 'absent' | 'malformed' | 'confinement'; reason: string };

/** Read + parse the repo's loop-capabilities.yaml, confined inside the repo working tree. The failure arm's
 *  `cause` distinguishes absent (degrade), malformed (human-owned), and confinement (security refusal). */
export function loadLoopCapabilities(repoDir: string): LoopCapabilitiesLoad {
  // resolveJail realpaths the repo dir and appends the filename WITHOUT resolving it, so a link planted at the
  // capabilities path is not adopted as the target; the O_NOFOLLOW open then refuses to traverse it (CWE-59).
  const target = resolveJail(repoDir, LOOP_CAPABILITIES_FILENAME);
  if (target === null) {
    return { ok: false, cause: 'confinement', reason: 'repository directory does not resolve' };
  }

  // One descriptor for the whole read (CWE-367): O_NOFOLLOW refuses a symlink at the final component, O_NONBLOCK
  // refuses to block on a FIFO, and fstat+read on that same fd close the stat↔read window a swapped inode wins.
  let fd: number;
  try {
    fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    if (isErrno(e, 'ENOENT')) return { ok: false, cause: 'absent', reason: 'no loop-capabilities.yaml in the repository' };
    if (isErrno(e, 'ELOOP')) return { ok: false, cause: 'confinement', reason: 'loop-capabilities.yaml is a symlink' };
    return { ok: false, cause: 'malformed', reason: `cannot open loop-capabilities.yaml: ${errMsg(e)}` };
  }

  let text: string;
  try {
    if (!fstatSync(fd).isFile()) return { ok: false, cause: 'malformed', reason: 'loop-capabilities.yaml is not a regular file' };
    // Read at most MAX+1 bytes FROM THIS fd (never readFileSync's read-to-EOF): a file appended-to after the
    // fstat cannot cause an unbounded read past the cap (CWE-400/770). MAX+1 bytes present ⇒ over the limit.
    const buf = Buffer.alloc(MAX_CAPABILITIES_BYTES + 1);
    let total = 0;
    for (;;) {
      const n = readSync(fd, buf, total, buf.length - total, total);
      if (n === 0 || total >= buf.length) break;
      total += n;
    }
    // The read stops at MAX+1 bytes (memory bound); over-cap CLASSIFICATION is the shared parse boundary's job.
    // Fatal decode: invalid UTF-8 is malformed, never silently normalized to U+FFFD (which would fail-away).
    text = decodeUtf8Strict(buf.subarray(0, total));
  } catch (e) {
    return { ok: false, cause: 'malformed', reason: `cannot read loop-capabilities.yaml: ${errMsg(e)}` };
  } finally {
    closeSync(fd);
  }

  const parsed = parseLoopCapabilities(text);
  return parsed.ok ? parsed : { ok: false, cause: 'malformed', reason: parsed.reason };
}
