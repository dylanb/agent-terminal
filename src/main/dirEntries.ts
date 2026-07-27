// One definition of how this process reads a directory it is enumerating a tree from (CLAUDE.md
// shared-semantics rule): the bundle reader and the skill lister had a copy each, and two copies of a
// policy that "obviously agree today" are the bug the rule exists to prevent.

import { readdirSync, type Dirent, promises as fsp } from 'node:fs';
import { isErrno } from './errno';

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
}

function toEntries(raw: Dirent[]): DirEntry[] {
  return raw
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile() }));
}

function absentIsEmpty(e: unknown): DirEntry[] {
  if (isErrno(e, 'ENOENT')) return [];
  throw e;
}

/** Entries of `dir`, name-sorted. An absent directory yields `[]`; every other failure — an unreadable tree
 *  above all — THROWS, so it can never be mistaken for an empty one and silently install nothing (§18.1). */
export function readDirEntries(dir: string): DirEntry[] {
  try {
    return toEntries(readdirSync(dir, { withFileTypes: true }));
  } catch (e) {
    return absentIsEmpty(e);
  }
}

/** `readDirEntries` for a caller that may not block the event loop while it walks (§27.11 / AC7). Same
 *  absent-yields-empty / unreadable-throws policy, from one definition. */
export async function readDirEntriesAsync(dir: string): Promise<DirEntry[]> {
  try {
    return toEntries(await fsp.readdir(dir, { withFileTypes: true }));
  } catch (e) {
    return absentIsEmpty(e);
  }
}
