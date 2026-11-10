import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import yaml from 'js-yaml';
import {
  BUNDLED_LOOPS_ROOT,
  bundledCharterFiles,
  bundledConsolidatorRecipes,
  bundledFlowLoops,
  bundledGoalLoopsWithReviewers,
  resolveBundledFlowLoop,
} from '../helpers/bundledLoops';

// #207 — each control below counts what a bundle discovery finds a second, independent way.

const dirs = (p: string): string[] => readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
const onDisk = (rel: (flow: string, loop: string) => string): string[] =>
  dirs(BUNDLED_LOOPS_ROOT).flatMap((flow) =>
    dirs(join(BUNDLED_LOOPS_ROOT, flow))
      .map((loop) => join(BUNDLED_LOOPS_ROOT, flow, loop, rel(flow, loop)))
      .filter((p) => statSync(p, { throwIfNoEntry: false })?.isFile() === true),
  );

describe('bundled loop discovery (#207 drift-test infrastructure)', () => {
  it('lists every (flow, loop) pair without assuming a retired flow is still shipped', () => {
    const pairs = bundledFlowLoops();
    expect(pairs.length).toBe(onDisk((_f, loop) => `${loop}.yaml`).length);
    expect(pairs.length).toBeGreaterThan(0);
    expect(new Set(pairs.map((p) => `${p.flow}/${p.loop}`)).size).toBe(pairs.length);
  });

  it('resolves each pair from its own flow folder', () => {
    for (const p of bundledFlowLoops()) {
      expect(resolveBundledFlowLoop(p).defDir, `${p.flow}/${p.loop}`).toBe(join(BUNDLED_LOOPS_ROOT, p.flow, p.loop));
    }
  });

  it('finds every consolidator recipe on disk, each resolved within its own flow', () => {
    const recipes = bundledConsolidatorRecipes();
    expect(recipes.map((r) => r.path).sort()).toEqual(onDisk(() => join('prompts', 'consolidate.md')).sort());
    for (const r of recipes) expect(r.path.startsWith(join(BUNDLED_LOOPS_ROOT, r.flow) + sep)).toBe(true);
  });

  it('finds exactly the defs that declare a work goal and reviewers, with every prompt file each names', () => {
    const byYaml = onDisk((_f, loop) => `${loop}.yaml`).filter((p) => {
      const doc = yaml.load(readFileSync(p, 'utf8')) as { work?: { goal?: unknown }; reviewers?: unknown[] };
      return typeof doc.work?.goal === 'string' && (doc.reviewers ?? []).length > 0;
    });
    const found = bundledGoalLoopsWithReviewers();
    expect(found.map((g) => join(BUNDLED_LOOPS_ROOT, g.flow, g.loop, `${g.loop}.yaml`)).sort()).toEqual(byYaml.sort());
    for (const g of found) {
      const doc = yaml.load(readFileSync(join(BUNDLED_LOOPS_ROOT, g.flow, g.loop, `${g.loop}.yaml`), 'utf8')) as { work: { goal: string } };
      expect(g.goal, `${g.flow}/${g.loop}`).toBe(doc.work.goal);
      expect(g.promptFiles, `${g.flow}/${g.loop}`).toContain(g.workRecipe);
    }
    const red = found.find((g) => g.flow === 'feature-dev-v3' && g.loop === 'red-loop');
    expect(red?.workRecipe.endsWith(join('red-loop', 'prompts', 'work.md'))).toBe(true);
    expect(red?.promptFiles.map((f) => f.slice(BUNDLED_LOOPS_ROOT.length + 1).split(sep).join('/')).sort()).toEqual([
      'feature-dev-v3/red-loop/prompts/brief.md',
      'feature-dev-v3/red-loop/prompts/work.md',
    ]);
  });

  it('walks every charter file, covering every charter a bundled def names', () => {
    const walked = new Set(bundledCharterFiles());
    const named = bundledFlowLoops().flatMap((p) => resolveBundledFlowLoop(p).def.reviewers.map((r) => r.charter));
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((c) => !walked.has(c))).toEqual([]);
    for (const c of walked) {
      expect(c.split(sep)).toContain('charter');
      expect(c.endsWith('.md'), c).toBe(true);
    }
  });
});
