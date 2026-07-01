import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  composeWorkPrompt,
  composeSpawnReviewersPrompt,
  composeConsolidatePrompt,
} from '../../src/main/loopRecipe';
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

// §26.4 — the reviewer fan-out is ONE prompt composed by main (no template file), naming each persona
// of the roster and instructing the instance to spawn them as parallel Task subagents, each writing its
// own review JSON under reviews/{iter}/. The done-signal instruction is appended like every actor turn.
describe('spawn-reviewers recipe composition (§26.4)', () => {
  const personas = ['review-principal', 'review-security', 'review-architecture'];

  it('names every persona and its iteration-scoped output path, and appends the done-signal', () => {
    const out = composeSpawnReviewersPrompt({ phase: 'plan', iteration: 3, personas, turnKey: 'review-plan' });
    for (const p of personas) {
      expect(out).toContain(p);
      expect(out).toContain(`reviews/3/${p}.json`); // the §26.4 per-persona artifact path
    }
    expect(out).toContain(turnDoneSentinel('review-plan')); // every actor turn carries the done-signal
  });

  it('instructs parallel subagent fan-out, not a serial walk', () => {
    const out = composeSpawnReviewersPrompt({ phase: 'plan', iteration: 1, personas, turnKey: 'review-plan' });
    expect(out.toLowerCase()).toContain('parallel');
  });
});

// §26.3/D45 + §26.13 L4 — the consolidate turn's prompt is assembled from the LoopDef's real
// prompts/consolidate.md template + token substitution (the §26.5 recipe assembly), given the verdict
// taxonomy via CLEAN_POLICY, with the done-signal instruction appended like every actor turn.
describe('consolidate recipe composition (§26.5/§26.3 D45)', () => {
  const configDir = resolve(__dirname, '..', '..', 'example');
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'consolidate-recipe-'));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('reads the real consolidate template body and appends the done-signal instruction', () => {
    const out = composeConsolidatePrompt({
      repoDir: repo,
      loopName: 'plan-loop',
      phase: 'plan',
      iteration: 3,
      turnKey: 'consolidate-plan',
      tokens: { CLEAN_POLICY: 'clean only when findings_kept is empty', SEVERITY_FLOOR: 'minor' },
      configDir,
    });
    expect(out).not.toBeNull();
    expect(out).toContain('Consolidator'); // the real template's heading body
    expect(out).toContain(turnDoneSentinel('consolidate-plan')); // the done-signal instruction is appended
  });

  it('substitutes the iteration/phase/review-dir/verdict-policy slots, leaving no provided token unresolved', () => {
    const out = composeConsolidatePrompt({
      repoDir: repo,
      loopName: 'plan-loop',
      phase: 'plan',
      iteration: 7,
      turnKey: 'consolidate-plan',
      tokens: { CLEAN_POLICY: 'CLEAN-POLICY-MARKER', SEVERITY_FLOOR: 'blocker' },
      configDir,
    });
    expect(out).toContain('7'); // {{ITERATION}}
    expect(out).toContain('reviews/7'); // {{REVIEW_DIR}} → .agent-loop/reviews/{iter}
    expect(out).toContain('CLEAN-POLICY-MARKER'); // {{CLEAN_POLICY}} carries the verdict taxonomy
    expect(out).toContain('blocker'); // {{SEVERITY_FLOOR}}
    expect(out).not.toContain('{{ITERATION}}');
    expect(out).not.toContain('{{PHASE}}');
    expect(out).not.toContain('{{REVIEW_DIR}}');
    expect(out).not.toContain('{{CLEAN_POLICY}}');
    expect(out).not.toContain('{{SEVERITY_FLOOR}}');
  });

  it('returns null when the consolidate template does not exist (on_missing: fail)', () => {
    // A repo-local override pointing at a def dir that has no prompts/consolidate.md → null.
    const out = composeConsolidatePrompt({
      repoDir: repo,
      loopName: 'no-such-loop',
      phase: 'plan',
      iteration: 1,
      turnKey: 'consolidate-plan',
      tokens: {},
      configDir,
    });
    expect(out).toBeNull();
  });
});
