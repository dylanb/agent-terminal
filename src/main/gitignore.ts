import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Append `entry` to `<dir>/.gitignore`, preserving existing content; a no-op when already listed.
 *  The shared primitive for app-owned per-directory state files (§19.1 / §25 / §8.4). */
export function ensureGitignored(dir: string, entry: string): void {
  const file = path.join(dir, '.gitignore');
  let existing = '';
  try {
    existing = readFileSync(file, 'utf8');
  } catch {
    existing = '';
  }
  if (existing.split('\n').some((l) => l.trim() === entry)) return;
  const prefix = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`;
  writeFileSync(file, `${prefix}${entry}\n`);
}
