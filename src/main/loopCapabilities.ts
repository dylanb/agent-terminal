// §28.5.4 / P8.5 — the standalone per-repo `loop-capabilities.yaml`: the "how to run it" data every loop def
// references. The engine NEVER executes test_command/build_command — they are inert strings the agent's
// recipe reads as guidance; the engine only parses and validates the shape. Validation mirrors loopDefV2.ts:
// a private error class + fail(), the shared isRecord guard, a closed key set, and a discriminated Result.
// The load path confines the file inside the untrusted repo working tree (resolveJail, CWE-22/59) and
// classifies a caught errno through errno.ts.

import { openSync, fstatSync, readSync, closeSync, constants } from 'node:fs';
import yaml from 'js-yaml';
import { isRecord } from './yamlRecord';
import { isErrno, errMsg } from './errno';
import { resolveJail } from './confinedPath';

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

// globMatch (§28.5.1) honors only `*`, `?`, and a WHOLE-segment `**`; braces, char-classes, and a partial `**`
// are literal there, so such a glob would match nothing and the frozen check would read as "no test changed" —
// a fail-AWAY. Rejecting here makes a bad glob a loud `malformed`, never silent under-matching.
function requireSupportedGlob(glob: string): void {
  if (/[{}[\]]/.test(glob)) {
    fail(`test_globs entry ${JSON.stringify(glob)} uses unsupported glob syntax ({}, []); only *, ?, and whole-segment ** are honored`);
  }
  for (const segment of glob.split('/')) {
    // git diff paths are repo-relative and normalized: an empty segment (leading/trailing/doubled `/`) or a
    // `.`/`..` segment can never appear, so such a glob matches nothing and the frozen check fails AWAY.
    if (segment === '' || segment === '.' || segment === '..') {
      fail(`test_globs entry ${JSON.stringify(glob)} has an empty or '.'/'..' path segment; git paths are repo-relative and normalized, so it can never match`);
    }
    if (segment.includes('**') && segment !== '**') {
      fail(`test_globs entry ${JSON.stringify(glob)} uses ** inside a segment; ** is honored only as a whole path segment`);
    }
  }
}

function requireTestGlobs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail('test_globs must be a non-empty array of path globs');
  }
  if (value.length > MAX_TEST_GLOBS) fail(`test_globs must list at most ${MAX_TEST_GLOBS} globs`);
  return value.map((glob) => {
    if (typeof glob !== 'string' || glob.trim() === '') fail('test_globs must contain only non-empty strings');
    if (glob.length > MAX_GLOB_LENGTH) fail(`test_globs entries must be at most ${MAX_GLOB_LENGTH} characters`);
    requireSupportedGlob(glob);
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
    if (total > MAX_CAPABILITIES_BYTES) return { ok: false, cause: 'malformed', reason: 'loop-capabilities.yaml is too large' };
    text = buf.toString('utf8', 0, total);
  } catch (e) {
    return { ok: false, cause: 'malformed', reason: `cannot read loop-capabilities.yaml: ${errMsg(e)}` };
  } finally {
    closeSync(fd);
  }

  const parsed = parseLoopCapabilities(text);
  return parsed.ok ? parsed : { ok: false, cause: 'malformed', reason: parsed.reason };
}
