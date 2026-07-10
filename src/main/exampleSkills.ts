// One definition of "a bundled skill" (§26.5), consumed by the install-time reader (skillFiles fans
// these into a shared skills root) and the build-time writer (which refuses a bundle whose skill names
// would collide there). A skill's identity is its directory name under a loop's `skills/`.

import { readdirSync } from 'node:fs';
import path from 'node:path';

const SKILLS_SUBDIR = 'skills';

export interface BundledSkill {
  loop: string;
  name: string;
  dir: string;
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export function listBundledSkills(loopsBundleDir: string): BundledSkill[] {
  const out: BundledSkill[] = [];
  for (const loop of subdirs(loopsBundleDir)) {
    const skillsRoot = path.join(loopsBundleDir, loop, SKILLS_SUBDIR);
    for (const name of subdirs(skillsRoot)) {
      out.push({ loop, name, dir: path.join(skillsRoot, name) });
    }
  }
  return out;
}

export interface SkillNameConflict {
  name: string;
  loops: string[];
}

/** Skill names shipped by more than one loop — each would land on the same install target (§26.5). */
export function skillNameConflicts(loopsBundleDir: string): SkillNameConflict[] {
  const byName = new Map<string, string[]>();
  for (const skill of listBundledSkills(loopsBundleDir)) {
    const loops = byName.get(skill.name);
    if (loops) loops.push(skill.loop);
    else byName.set(skill.name, [skill.loop]);
  }
  return [...byName]
    .filter(([, loops]) => loops.length > 1)
    .map(([name, loops]) => ({ name, loops }));
}
