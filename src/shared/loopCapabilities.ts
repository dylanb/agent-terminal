// §28.5.4 — the framework-neutral per-repo `loop-capabilities.yaml` DESCRIPTOR: its shape, its serialized key
// vocabulary, and the parse predicate that validates them. Lives in src/shared (issue #105) so a future
// recipe/prompt writer and the main-process reader share ONE contract that cannot drift (writer↔reader).
// Nothing here touches node:fs; the main-process reader supplies the bytes.

import yaml from 'js-yaml';
import { unsupportedGlobReason } from './globMatch';

export const LOOP_CAPABILITIES_FILENAME = 'loop-capabilities.yaml';

// Defense-in-depth bounds on untrusted input (CWE-400/770): a size cap on the file, and caps on the glob
// list the matcher would iterate. Generous — a real capabilities file is tiny.
export const MAX_CAPABILITIES_BYTES = 512 * 1024;
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

class CapError extends Error {}
function fail(reason: string): never {
  throw new CapError(reason);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireNonBlankString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(`${what} must be a non-empty string`);
  return value;
}

// The supported grammar is defined once in ./globMatch; rejecting a glob the matcher cannot honor makes it a
// loud `malformed` rather than a silent fail-away, and cannot drift from what globMatch actually matches.
function requireSupportedGlob(glob: string): void {
  const reason = unsupportedGlobReason(glob);
  if (reason !== null) fail(`test_globs entry ${JSON.stringify(glob)} ${reason}`);
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
  // The size cap lives at this shared parse boundary so every byte-source reader classifies an over-cap file
  // identically (CWE-400/770). TextEncoder (not Buffer) keeps the shared module renderer-safe.
  if (new TextEncoder().encode(text).length > MAX_CAPABILITIES_BYTES) fail('loop-capabilities.yaml is too large');
  let doc: unknown;
  try {
    doc = yaml.load(text);
  } catch (e) {
    fail(`malformed yaml: ${e instanceof Error ? e.message : String(e)}`);
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
