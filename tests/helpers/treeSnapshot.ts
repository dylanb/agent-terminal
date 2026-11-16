import { lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

/** Every entry under `root` except `.git/`, keyed by its relative path: a file's bytes, a symlink's target, or
 *  `<dir>` for a directory. Two equal snapshots are the same working tree, byte for byte. */
export function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      const path = rel === '' ? name : `${rel}/${name}`;
      if (path === '.git') continue;
      const abs = join(root, path);
      const stat = lstatSync(abs);
      if (stat.isSymbolicLink()) out[path] = `-> ${readlinkSync(abs)}`;
      else if (stat.isDirectory()) {
        out[path] = '<dir>';
        walk(path);
      } else out[path] = readFileSync(abs).toString('base64');
    }
  };
  walk('');
  return out;
}
