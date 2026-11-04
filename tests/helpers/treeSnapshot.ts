// What a tree holds, for a before/after comparison that proves a run wrote nothing: every path under a root,
// its type, a file's bytes and a link's target. Links are recorded, never followed.

import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { isErrno } from '../../src/main/errno';

export type TreeEntry =
  | { type: 'dir' }
  | { type: 'file'; bytes: string }
  | { type: 'link'; target: string }
  | { type: 'other' };

/** Keyed by the path relative to `root` (`''` is the root itself); an absent root is an empty snapshot. */
export function snapshotTree(root: string): Record<string, TreeEntry> {
  const out: Record<string, TreeEntry> = {};
  const visit = (rel: string): void => {
    const abs = rel === '' ? root : join(root, rel);
    let stat;
    try {
      stat = lstatSync(abs);
    } catch (e) {
      if (rel === '' && isErrno(e, 'ENOENT')) return;
      throw e;
    }
    if (stat.isSymbolicLink()) out[rel] = { type: 'link', target: readlinkSync(abs) };
    else if (stat.isFile()) out[rel] = { type: 'file', bytes: readFileSync(abs).toString('base64') };
    else if (stat.isDirectory()) {
      out[rel] = { type: 'dir' };
      for (const name of readdirSync(abs).sort()) visit(rel === '' ? name : join(rel, name));
    } else out[rel] = { type: 'other' };
  };
  visit('');
  return out;
}
