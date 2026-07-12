// One definition of how this process reads a directory it is enumerating a tree from (CLAUDE.md
// shared-semantics rule): the bundle reader and the skill lister had a copy each, and two copies of a
// policy that "obviously agree today" are the bug the rule exists to prevent.

import { readdirSync } from 'node:fs';
import { isErrno } from './errno';

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
}

/** Entries of `dir`, name-sorted. An absent directory yields `[]`; every other failure — an unreadable tree
 *  above all — THROWS, so it can never be mistaken for an empty one and silently install nothing (§18.1). */
export function readDirEntries(dir: string): DirEntry[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile() }));
  } catch (e) {
    if (isErrno(e, 'ENOENT')) return [];
    throw e;
  }
}
