// §28.5.4 — the main-process READER for the per-repo `loop-capabilities.yaml`: it supplies the bytes to the
// shared parse predicate (src/shared/loopCapabilities.ts, the ONE descriptor+parse contract, issue #105) and
// confines the file inside the untrusted repo working tree (resolveJail, CWE-22/59), classifying a caught
// errno through errno.ts. The engine NEVER executes test_command/build_command — they are inert guidance the
// agent's recipe reads; this reader only parses and validates shape.

import { statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isErrno, errMsg } from './errno';
import { resolveJail, confinedRealPathResult } from './confinedPath';
import {
  parseLoopCapabilities,
  LOOP_CAPABILITIES_FILENAME,
  MAX_CAPABILITIES_BYTES,
  type LoopCapabilities,
} from '../shared/loopCapabilities';

/** The load failure arm carries a discriminated `cause` (mirroring confinedPath's `PathRefusal`) so a
 *  consumer (S3/S4) branches on the kind — absent → degrade coherently (§28.5.6); malformed → human-owned
 *  error; confinement → a security refusal — never by substring-matching the human `reason`. */
export type LoopCapabilitiesLoad =
  | { ok: true; value: LoopCapabilities }
  | { ok: false; cause: 'absent' | 'malformed' | 'confinement'; reason: string };

/** Read + parse the repo's loop-capabilities.yaml, confined inside the repo working tree. The failure arm's
 *  `cause` distinguishes absent (degrade), malformed (human-owned), and confinement (security refusal). */
export function loadLoopCapabilities(repoDir: string): LoopCapabilitiesLoad {
  const jail = resolveJail(repoDir);
  if (jail === null) {
    return { ok: false, cause: 'confinement', reason: 'repository directory does not resolve' };
  }
  const confined = confinedRealPathResult(jail, join(jail, LOOP_CAPABILITIES_FILENAME));
  if (!confined.ok) {
    const reason =
      confined.cause === 'escapes'
        ? 'loop-capabilities.yaml escapes the repository'
        : 'loop-capabilities.yaml cannot be resolved';
    return { ok: false, cause: 'confinement', reason };
  }

  let size: number;
  try {
    const st = statSync(confined.path);
    if (!st.isFile()) return { ok: false, cause: 'malformed', reason: 'loop-capabilities.yaml is not a regular file' };
    size = st.size;
  } catch (e) {
    if (isErrno(e, 'ENOENT')) return { ok: false, cause: 'absent', reason: 'no loop-capabilities.yaml in the repository' };
    return { ok: false, cause: 'malformed', reason: `cannot stat loop-capabilities.yaml: ${errMsg(e)}` };
  }
  if (size > MAX_CAPABILITIES_BYTES) {
    return { ok: false, cause: 'malformed', reason: 'loop-capabilities.yaml is too large' };
  }

  let text: string;
  try {
    text = readFileSync(confined.path, 'utf8'); // the confined real path, never a re-derived one (TOCTOU)
  } catch (e) {
    if (isErrno(e, 'ENOENT')) return { ok: false, cause: 'absent', reason: 'no loop-capabilities.yaml in the repository' };
    return { ok: false, cause: 'malformed', reason: `cannot read loop-capabilities.yaml: ${errMsg(e)}` };
  }

  const parsed = parseLoopCapabilities(text);
  return parsed.ok ? parsed : { ok: false, cause: 'malformed', reason: parsed.reason };
}
