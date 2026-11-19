import fs from 'node:fs';
import path from 'node:path';

export type OwnerOnlyCheck =
  | { kind: 'ownerOnly' }
  | { kind: 'othersCanWrite' }
  | { kind: 'ownedByAnother' }
  | { kind: 'unreadable'; error: unknown };

const ROOT_UID = 0;

/** CWE-276/426: a path's owner can always replace it, so only the user and root may own it, and only they may
 *  write it. */
function judge(stats: fs.Stats, user: number): OwnerOnlyCheck {
  if (stats.uid !== user && stats.uid !== ROOT_UID) return { kind: 'ownedByAnother' };
  if ((stats.mode & 0o022) !== 0) return { kind: 'othersCanWrite' };
  return { kind: 'ownerOnly' };
}

export function ownerOnlyPath(p: string, user: number): OwnerOnlyCheck {
  try {
    return judge(fs.statSync(p), user);
  } catch (e) {
    return { kind: 'unreadable', error: e };
  }
}

/** CWE-59: the real folders are judged, so a symlink cannot hide a folder others can write. */
export function ownerOnlyChain(start: string, user: number, stopAt?: string): OwnerOnlyCheck {
  let cur: string;
  try {
    cur = fs.realpathSync(start);
  } catch (e) {
    return { kind: 'unreadable', error: e };
  }
  for (; cur !== stopAt; cur = path.dirname(cur)) {
    const check = ownerOnlyPath(cur, user);
    switch (check.kind) {
      case 'ownerOnly':
        break;
      case 'othersCanWrite':
      case 'ownedByAnother':
        return check;
      // untestable: `cur` just resolved, so it is unreadable only if it changes in between; tracked in #153.
      case 'unreadable':
        return check;
      default:
        return check satisfies never;
    }
    if (cur === path.dirname(cur)) break;
  }
  return { kind: 'ownerOnly' };
}

export function isPrivateDirectory(stats: fs.Stats, user: number): boolean {
  return stats.isDirectory() && stats.uid === user && (stats.mode & 0o777) === 0o700;
}
