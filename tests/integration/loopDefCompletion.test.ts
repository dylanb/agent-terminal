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

/** Resolve groom-loop from an operator tier whose def yaml has been patched by `patch`. */
function resolvePatched(patch: (yaml: string) => string): LoopDefV2Result {
  cpSync(join(APP_BUNDLED, 'groom-loop'), join(tier, 'groom-loop'), { recursive: true });
  const defPath = join(tier, 'groom-loop', 'groom-loop.yaml');
  writeFileSync(defPath, patch(readFileSync(defPath, 'utf8')));
  return resolveLoopDefV2('groom-loop', { tiers: { operator: tier, appBundled: APP_BUNDLED, retired: null }, repoDir });
}
const addCompletion = (value: string) => (y: string): string =>
  y.replace(ARTIFACT_LINE, `${ARTIFACT_LINE}  completion: ${value}\n`);

describe('§28.4/§28.5.5 — the work.completion discriminator', () => {
  it('UT-DEF-4: WORK_COMPLETIONS is the single-sourced closed set the type and guard both derive from', () => {
    expect(WORK_COMPLETIONS).toEqual(['red']);
    expect(isWorkCompletion('red')).toBe(true);
    expect(isWorkCompletion('green')).toBe(false); // extends the set in S4/S5, not here
    expect(isWorkCompletion('RED')).toBe(false); // never normalized
    expect(isWorkCompletion('')).toBe(false);
  });

  it('UT-DEF-1: parses work.completion: red onto the def', () => {
    const r = resolvePatched(addCompletion('red'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.def.work.completion).toBe('red');
  });

  it('UT-DEF-2: leaves completion undefined when the field is absent (S1/S2 defs still valid)', () => {
    const r = resolvePatched((y) => y); // the unmodified bundled groom-loop, no completion field
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.def.work.completion).toBeUndefined();
  });

  it('UT-DEF-3: rejects an unknown completion value (closed set)', () => {
    const r = resolvePatched(addCompletion('purple'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/completion/i);
  });
});
