import { statSync } from 'node:fs';
import path from 'node:path';
import { readDirEntries } from './dirEntries';
import { isErrno } from './errno';
import { loopDefLocation } from './loopDefV2';

export interface LoopFolder {
  name: string;
  dir: string;
  flow: string | null;
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch (e) {
    if (isErrno(e, 'ENOENT')) return false;
    throw e;
  }
}

export function listLoopFolders(loopsRoot: string): LoopFolder[] {
  const folders: LoopFolder[] = [];
  const addIfDefined = (name: string, flow: string | null): void => {
    const at = loopDefLocation(loopsRoot, name, flow);
    if (at !== null && isFile(at.defPath)) folders.push({ name, dir: at.defDir, flow });
  };
  for (const top of readDirEntries(loopsRoot)) {
    if (!top.isDirectory) continue;
    addIfDefined(top.name, null);
    for (const loop of readDirEntries(path.join(loopsRoot, top.name))) {
      if (loop.isDirectory) addIfDefined(loop.name, top.name);
    }
  }
  return folders;
}
