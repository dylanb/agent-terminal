// §28.5.4 / P8.5 — the standalone per-repo `loop-capabilities.yaml`: the "how to run it" data every loop def
// references. The engine NEVER executes test_command/build_command — they are inert strings the agent's
// recipe reads as guidance; the engine only parses and validates the shape. Validation mirrors loopDefV2.ts:
// a private error class + fail(), the shared isRecord guard, a closed key set, and a discriminated Result.
// The load path confines the file inside the untrusted repo working tree (resolveJail, CWE-22/59) and
// classifies a caught errno through errno.ts.

import { statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { isRecord } from './yamlRecord';
import { isErrno, errMsg } from './errno';
import { resolveJail, confinedRealPathResult } from './confinedPath';

export const LOOP_CAPABILITIES_FILENAME = 'loop-capabilities.yaml';

// Defense-in-depth bounds on untrusted input (CWE-400/770): a size cap on the file, and caps on the glob
// list the matcher would iterate. Generous — a real capabilities file is tiny.
const MAX_CAPABILITIES_BYTES = 512 * 1024;
const MAX_TEST_GLOBS = 256;
const MAX_GLOB_LENGTH = 1024;

const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'test_globs',
  'test_command',
  'build_command',
  'select_template',
]);

export interface LoopCapabilities {
  testGlobs: string[];
  testCommand: string;
  buildCommand: string;
  selectTemplate?: string;
}

export type LoopCapabilitiesParse =
  | { ok: true; value: LoopCapabilities }
  | { ok: false; reason: string };

/** The load failure arm carries a discriminated `cause` (mirroring confinedPath's `PathRefusal`) so a
 *  consumer (S3/S4) branches on the kind — absent → degrade coherently (§28.5.6); malformed → human-owned
 *  error; confinement → a security refusal — never by substring-matching the human `reason`. */
export type LoopCapabilitiesLoad =
  | { ok: true; value: LoopCapabilities }
  | { ok: false; cause: 'absent' | 'malformed' | 'confinement'; reason: string };

class CapError extends Error {}
function fail(reason: string): never {
  throw new CapError(reason);
}

function requireNonBlankString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(`${what} must be a non-empty string`);
  return value;
}

function requireTestGlobs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail('test_globs must be a non-empty array of path globs');
  }
  if (value.length > MAX_TEST_GLOBS) fail(`test_globs must list at most ${MAX_TEST_GLOBS} globs`);
  return value.map((glob) => {
    if (typeof glob !== 'string' || glob.trim() === '') fail('test_globs must contain only non-empty strings');
    if (glob.length > MAX_GLOB_LENGTH) fail(`test_globs entries must be at most ${MAX_GLOB_LENGTH} characters`);
    return glob;
  });
}

function parse(text: string): LoopCapabilities {
  let doc: unknown;
  try {
    doc = yaml.load(text);
  } catch (e) {
    fail(`malformed yaml: ${errMsg(e)}`);
  }
  if (!isRecord(doc)) fail('loop-capabilities.yaml must be a mapping');
  // Closed key set BEFORE reading fields: a `__proto__`/`constructor` key (js-yaml stores it as an own key,
  // no prototype pollution) is rejected here as unknown, exactly like loopDefV2's ALLOWED_TOP_KEYS.
  for (const key of Object.keys(doc)) {
    if (!ALLOWED_KEYS.has(key)) fail(`unknown key: ${key}`);
  }
  const result: LoopCapabilities = {
    testGlobs: requireTestGlobs(doc.test_globs),
    testCommand: requireNonBlankString(doc.test_command, 'test_command'),
    buildCommand: requireNonBlankString(doc.build_command, 'build_command'),
  };
  if (doc.select_template !== undefined) {
    result.selectTemplate = requireNonBlankString(doc.select_template, 'select_template');
  }
  return result;
}

/** Parse capabilities from yaml text into the four fields, or a surfaced reason (never throws). */
export function parseLoopCapabilities(text: string): LoopCapabilitiesParse {
  try {
    return { ok: true, value: parse(text) };
  } catch (e) {
    if (e instanceof CapError) return { ok: false, reason: e.message };
    throw e;
  }
}

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
