import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveAppLoopView } from '../../src/main/loopViewV2';
import type { LoopDefV2Tiers } from '../../src/main/loopDefV2';

// The §27 loop-view provider (the READ meeting point, engine-selected on the flow step's `app` namespace):
// it resolves the bound app-def and produces the whole loop view the strip/panel render — a run-less view
// (gate options display-only, no round has run) or a def-failure view carrying the reason (AC 6). It reads
// no §26 loop state, so a §27 step renders with §26 defs and §26 loop state absent (AC "neither path").

const DEF = (opts: string[]): string => `version: v2
name: plan-loop
work:
  recipe: prompts/work.md
  artifact: plan
reviewers: []
consolidator:
  recipe: prompts/consolidate.md
boundaries: []
report:
  sections: [summary]
gate:
${opts.map((o) => `  - option: ${o}\n    side_effects: []`).join('\n')}
pickup:
  initial_status: planning
  branch_template: plan-loop/issue-{issue}
`;

let appDir: string;
let repoDir: string;
function tiers(): LoopDefV2Tiers {
  return { operator: null, appBundled: join(appDir, 'loops-v2') };
}
function plant(name: string, opts: string[]): void {
  const defDir = join(appDir, 'loops-v2', name);
  mkdirSync(join(defDir, 'prompts'), { recursive: true });
  writeFileSync(join(defDir, 'prompts', 'work.md'), 'do work\n');
  writeFileSync(join(defDir, 'prompts', 'consolidate.md'), 'judge\n');
  writeFileSync(join(defDir, `${name}.yaml`), DEF(opts).replace('name: plan-loop', `name: ${name}`));
}

beforeEach(() => {
  appDir = mkdtempSync(join(tmpdir(), 'lv2-app-'));
  repoDir = mkdtempSync(join(tmpdir(), 'lv2-repo-'));
});
afterEach(() => {
  for (const d of [appDir, repoDir]) rmSync(d, { recursive: true, force: true });
});

describe('deriveAppLoopView — run-less view (AC 1)', () => {
  it('renders the resolved def\'s gate options display-only, with no round having run', () => {
    plant('plan-loop', ['approve', 'request-changes']);
    const view = deriveAppLoopView('plan-loop', { tiers: tiers(), repoDir });
    expect(view.gateOptions).toEqual(['approve', 'request-changes']);
    expect(view.actionable).toBe(false); // display-only — the guard is at the operation, not the render
    expect(view.iteration).toBeUndefined(); // no round has run — not a fabricated 0
    expect(view.humanNeeded).toBe(false);
    expect(view.ready).toBe(false);
  });

  it('differs between defs that declare different gate options', () => {
    plant('plan-loop', ['approve', 'request-changes']);
    plant('groom-loop', ['approve', 'reject']);
    const plan = deriveAppLoopView('plan-loop', { tiers: tiers(), repoDir });
    const groom = deriveAppLoopView('groom-loop', { tiers: tiers(), repoDir });
    expect(plan.gateOptions).toEqual(['approve', 'request-changes']);
    expect(groom.gateOptions).toEqual(['approve', 'reject']);
  });
});

describe('deriveAppLoopView — def-failure view (AC 6)', () => {
  it('surfaces the reason for an unresolvable def, marked human-needed with no round', () => {
    const view = deriveAppLoopView('nowhere-loop', { tiers: tiers(), repoDir });
    expect(view.status).toBe('error');
    expect(view.errorReason).toContain('nowhere-loop');
    expect(view.humanNeeded).toBe(true);
    expect(view.iteration).toBeUndefined();
    expect(view.actionable).toBe(false);
  });

  it('surfaces the reason for a malformed def rather than throwing', () => {
    const defDir = join(appDir, 'loops-v2', 'plan-loop');
    mkdirSync(defDir, { recursive: true });
    writeFileSync(join(defDir, 'plan-loop.yaml'), 'version: v2\nname: [unterminated');
    const view = deriveAppLoopView('plan-loop', { tiers: tiers(), repoDir });
    expect(view.status).toBe('error');
    expect(view.errorReason).toBeTruthy();
  });
});
