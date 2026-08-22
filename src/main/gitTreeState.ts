import { isUnderAppStateDir } from './appStateDirs';

export function treeIsClean(porcelain: string): boolean {
  return porcelain
    .split('\n')
    .filter((line) => line.length > 0)
    .every((line) => line.slice(3).split(' -> ').every(isUnderAppStateDir));
}
