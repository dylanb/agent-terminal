import { APP_STATE_DIRS } from './appStateDirs';

const APP_STATE_PREFIXES = APP_STATE_DIRS.map((d) => `${d}/`);

export function treeIsClean(porcelain: string): boolean {
  const isAppState = (p: string): boolean => APP_STATE_PREFIXES.some((prefix) => p.startsWith(prefix));
  return porcelain
    .split('\n')
    .filter((line) => line.length > 0)
    .every((line) => line.slice(3).split(' -> ').every(isAppState));
}
