import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { composeWorkPrompt } from '../../src/main/loopRecipe';
import { turnDoneSentinel } from '../../src/shared/loopTurn';

// §26.5 / §26.3 — the orchestrator composes the work-{phase} turn prompt from the bound LoopDef recipe.
// L2 is minimal-but-real: the template body (prompts/work-{phase}.md) + resolvable token substitution +
// the appended done-signal instruction. Exercised against the REAL plan-loop def in example/loops.
describe('work-{phase} recipe composition (§26.5/§26.3)', () => {
  const configDir = resolve(__dirname, '..', '..', 'example');
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'recipe-'));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('reads the real work-plan template body and appends the done-signal instruction', () => {
    const out = composeWorkPrompt({
      repoDir: repo,
      loopName: 'plan-loop',
      phase: 'plan',
      turnKey: 'work-plan',
      tokens: { PLAN_LINE_THRESHOLD: '1000' },
      configDir,
    });
    expect(out).not.toBeNull();
    expect(out).toContain('Work agent'); // the real template's heading body
    expect(out).toContain(turnDoneSentinel('work-plan')); // the done-signal instruction is appended
  });

  it('substitutes resolvable tokens, leaving no unresolved copy of a provided token', () => {
    const out = composeWorkPrompt({
      repoDir: repo,
      loopName: 'plan-loop',
      phase: 'plan',
      turnKey: 'work-plan',
      tokens: { PLAN_LINE_THRESHOLD: '1234' },
      configDir,
    });
    expect(out).toContain('1234');
    expect(out).not.toContain('{{PLAN_LINE_THRESHOLD}}');
  });

  it('returns null when the phase template does not exist (on_missing: fail)', () => {
    const out = composeWorkPrompt({
      repoDir: repo,
      loopName: 'plan-loop',
      phase: 'no-such-phase',
      turnKey: 'work-no-such-phase',
      tokens: {},
      configDir,
    });
    expect(out).toBeNull();
  });
});
