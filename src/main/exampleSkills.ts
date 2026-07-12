// One definition of "a bundled skill" (§26.5), consumed by the install-time reader (skillFiles fans
// these into a shared skills root) and the build-time writer (which refuses a bundle whose skill names
// would collide there). A skill's identity is its directory name under a loop's `skills/`.

import { readdirSync } from 'node:fs';
import path from 'node:path';

const SKILLS_SUBDIR = 'skills';

export interface BundledSkill {
  loop: string;
  name: string;
  /** The loop's `skills/` root. A skill installs at `<skills root>/<name>/`, so the path each of its files
   *  takes under the install destination is relative to THIS — not to the skill's own directory. */
  root: string;
  dir: string;
}

/** Absence is the only failure that reads as "no skills here" (a loop may ship none); an unreadable or
 *  corrupt tree throws rather than enumerating to nothing, which an installer cannot tell from empty. */
function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

export function listBundledSkills(loopsBundleDir: string): BundledSkill[] {
  const out: BundledSkill[] = [];
  for (const loop of subdirs(loopsBundleDir)) {
    const skillsRoot = path.join(loopsBundleDir, loop, SKILLS_SUBDIR);
    for (const name of subdirs(skillsRoot)) {
      out.push({ loop, name, root: skillsRoot, dir: path.join(skillsRoot, name) });
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
