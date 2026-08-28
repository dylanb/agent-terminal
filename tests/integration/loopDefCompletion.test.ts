import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveLoopDefV2,
  WORK_COMPLETIONS,
  isWorkCompletion,
  type LoopDefV2Result,
} from '../../src/main/loopDefV2';

// §28.4/§28.5.5 — the work.completion discriminator: an additive, closed-set field naming which machine
// completion predicate a work turn uses (`red` in S3; extends to green/refactor in S4/S5). Parsed by resolving
// a real def from an operator tier (a patched copy of the bundled groom-loop), no mock parser.
const APP_BUNDLED = join(process.cwd(), 'example', 'loops-v2');
const ARTIFACT_LINE = '  artifact: groomed-ticket\n';

let repoDir: string;
let tier: string;
beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'defcomp-'));
  tier = mkdtempSync(join(tmpdir(), 'defcomp-tier-'));
});
afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(tier, { recursive: true, force: true });
});

const resolveBundled = (): LoopDefV2Result =>
  resolveLoopDefV2('groom-loop', { tiers: { operator: null, appBundled: APP_BUNDLED, retired: null }, repoDir });

/** Resolve groom-loop from an operator tier whose def yaml has been patched by `patch` (which MUST change it —
 *  asserted, so a fixture that drifts off the bundled yaml fails self-explainingly, not as a downstream mismatch). */
function resolvePatched(patch: (yaml: string) => string): LoopDefV2Result {
  cpSync(join(APP_BUNDLED, 'groom-loop'), join(tier, 'groom-loop'), { recursive: true });
  const defPath = join(tier, 'groom-loop', 'groom-loop.yaml');
  const original = readFileSync(defPath, 'utf8');
  const patched = patch(original);
  expect(patched, 'the fixture patch did not change the bundled def (anchor drifted?)').not.toBe(original);
  writeFileSync(defPath, patched);
  return resolveLoopDefV2('groom-loop', { tiers: { operator: tier, appBundled: APP_BUNDLED, retired: null }, repoDir });
}
const addCompletion = (value: string) => (y: string): string =>
  y.replace(ARTIFACT_LINE, `${ARTIFACT_LINE}  completion: ${value}\n`);

describe('§28.4/§28.5.5 — the work.completion discriminator', () => {
  it('UT-DEF-4: WORK_COMPLETIONS is the single-sourced closed set the type and guard both derive from', () => {
    expect(WORK_COMPLETIONS).toEqual(['red', 'green']);
    expect(isWorkCompletion('red')).toBe(true);
    expect(isWorkCompletion('green')).toBe(true); // S4 adds the GREEN completion mode
    expect(isWorkCompletion('refactor')).toBe(false); // extends the set in S5, not here
    expect(isWorkCompletion('RED')).toBe(false); // never normalized
    expect(isWorkCompletion('')).toBe(false);
  });

  it('UT-DEF-1: parses work.completion: red onto the def', () => {
    const r = resolvePatched(addCompletion('red'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.def.work.completion).toBe('red');
  });

  it('UT-DEF-1g: parses work.completion: green onto the def', () => {
    const r = resolvePatched(addCompletion('green'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.def.work.completion).toBe('green');
  });

  it('UT-DEF-2: leaves completion undefined when the field is absent (S1/S2 defs still valid)', () => {
    const r = resolveBundled(); // the unmodified bundled groom-loop, no completion field
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.def.work.completion).toBeUndefined();
  });

  it('UT-DEF-3: rejects an unknown completion value (closed set)', () => {
    const r = resolvePatched(addCompletion('purple'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/completion/i);
  });

  it('UT-DEF-3b: rejects a non-string completion value', () => {
    const r = resolvePatched((y) => y.replace(ARTIFACT_LINE, `${ARTIFACT_LINE}  completion: [red]\n`));
    expect(r.ok).toBe(false);
  });

  // §28.5.5 F1 fail-closed: a RED turn validates a result FILE, so completion: red requires work.artifact to
  // name a real output binding. Without this, a completion:red def with an unresolvable artifact would reach
  // the RED gate with no result-file path to shape-validate (a false-pass on the done-signal alone).
  it('UT-DEF-5: rejects completion: red when work.artifact names no output binding', () => {
    const r = resolvePatched((y) => y.replace(ARTIFACT_LINE, '  artifact: no-such-binding\n  completion: red\n'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/output binding|artifact/i);
  });

  it('UT-DEF-5b: an unresolvable artifact with NO completion mode is still accepted (the guard is completion-specific)', () => {
    // a `commits`-style artifact legitimately names no binding — the binding requirement fires for a DECLARED
    // completion mode (red or green, UT-DEF-5/5g), never for a completion-less def.
    const r = resolvePatched((y) => y.replace(ARTIFACT_LINE, '  artifact: no-such-binding\n'));
    expect(r.ok).toBe(true);
  });

  // §28.5.5 F1 — the result-file binding guard is completion-generic: GREEN also validates a result FILE, so
  // completion: green requires work.artifact to name a real output binding (same fail-closed as red).
  it('UT-DEF-5g: rejects completion: green when work.artifact names no output binding', () => {
    const r = resolvePatched((y) => y.replace(ARTIFACT_LINE, '  artifact: no-such-binding\n  completion: green\n'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/output binding|artifact/i);
  });
});
