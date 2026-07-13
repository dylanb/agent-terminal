import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listBundledSkills, skillNameConflicts } from '../../src/main/exampleSkills';

// The install-examples action fans every bundled loop's `skills/<name>/` into one shared skills root
// (§26.5), so two loops shipping the same skill NAME would collapse onto one target — and preview would
// miss it (it sees a clean machine) while apply silently drops the second copy. The bundle avoids this by
// naming discipline; nothing enforced it. skillNameConflicts is that enforcement, run at build time.

let loops: string;

function seedSkill(loop: string, skill: string): void {
  const dir = path.join(loops, loop, 'skills', skill);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), `# ${loop}/${skill}\n`);
}

beforeEach(() => {
  loops = mkdtempSync(path.join(tmpdir(), 'ex-skills-'));
});
afterEach(() => {
  rmSync(loops, { recursive: true, force: true });
});

describe('listBundledSkills — one skill identity, keyed by directory name under a loop', () => {
  it('lists every skill in every loop, tagged with the loop it came from', () => {
    seedSkill('plan-loop', 'review-intent');
    seedSkill('impl-loop', 'impl-review-tests');
    const skills = listBundledSkills(loops);
    expect(skills.map((s) => `${s.loop}/${s.name}`).sort()).toEqual([
      'impl-loop/impl-review-tests',
      'plan-loop/review-intent',
    ]);
  });

  it('returns nothing for a loops tree with no skills', () => {
    mkdirSync(path.join(loops, 'plan-loop'), { recursive: true });
    writeFileSync(path.join(loops, 'plan-loop', 'plan-loop.yaml'), 'name: plan-loop\n');
    expect(listBundledSkills(loops)).toEqual([]);
  });
});

describe('skillNameConflicts — a skill name shipped by more than one loop is a conflict', () => {
  it('reports a name shared across two loops, naming every loop that ships it', () => {
    seedSkill('plan-loop', 'review-security');
    seedSkill('impl-loop', 'review-security');
    seedSkill('impl-loop', 'impl-review-tests');
    const conflicts = skillNameConflicts(loops);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].name).toBe('review-security');
    expect(conflicts[0].loops.sort()).toEqual(['impl-loop', 'plan-loop']);
  });

  it('reports no conflict when every skill name is unique across loops', () => {
    seedSkill('plan-loop', 'review-intent');
    seedSkill('impl-loop', 'impl-review-tests');
    expect(skillNameConflicts(loops)).toEqual([]);
  });
});

describe('the real bundled loops carry no colliding skill name', () => {
  it('has no skill name shipped by more than one loop', () => {
    const conflicts = skillNameConflicts(path.resolve('example', 'loops'));
    expect(conflicts).toEqual([]);
  });
});
