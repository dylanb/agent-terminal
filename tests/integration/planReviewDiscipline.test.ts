import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveExampleLoopsV2Dir } from '../../src/main/exampleAssets';
import { resolveLoopDefV2 } from '../../src/main/loopDefV2';

// The plan-bundle reviewers converge only when every lens shares the materiality floor, scope cuts both ways,
// the security lens has a bounded adversary, polish is deferred, and the plan stays at contract altitude.
const SOURCE = resolveExampleLoopsV2Dir({ packaged: false, appPath: resolve(__dirname, '..', '..') });
const LOOP = 'plan-bundle-loop';
const read = (rel: string): string => readFileSync(join(SOURCE, rel), 'utf8');
const charters = readdirSync(join(SOURCE, LOOP, 'charter')).map((f) => `${LOOP}/charter/${f}`);

const MATERIALITY_MARKER = 'Raise a finding only where';
const SCOPE_MARKER = 'beyond what the ticket requires';
const ADVERSARY_MARKER = 'an attack outside that scope';
const ALTITUDE_MARKER = 'contracts and intent';

describe('plan-bundle review discipline', () => {
  for (const f of charters) {
    it(`${f} carries the materiality floor`, () => expect(read(f)).toContain(MATERIALITY_MARKER));
    it(`${f} treats additions beyond the ticket as a finding`, () => expect(read(f)).toContain(SCOPE_MARKER));
  }

  it('the work recipe forbids adding scope beyond the ticket', () =>
    expect(read(`${LOOP}/prompts/work.md`)).toContain(SCOPE_MARKER));

  it('the security charter bounds the adversary and routes a new attack class to a human', () => {
    const security = read(`${LOOP}/charter/security.md`);
    expect(security).toContain(ADVERSARY_MARKER);
    expect(security).toContain('needs a human');
  });

  it('the plan is written at contract altitude, and maintainability no longer demands code-level detail', () => {
    expect(read(`${LOOP}/prompts/work.md`)).toContain(ALTITUDE_MARKER);
    const maintainability = read(`${LOOP}/charter/maintainability.md`);
    expect(maintainability).toContain(ALTITUDE_MARKER);
    expect(maintainability).not.toContain('Layer-3 detail');
  });

  it('the loop defers polish', () => {
    const r = resolveLoopDefV2(LOOP, {
      tiers: { operator: null, appBundled: SOURCE, retired: null },
      repoDir: resolve(__dirname, '..', '..'),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.def.report.polish).toBe('defer');
  });
});
