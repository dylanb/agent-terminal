import { TURN_DONE_FILENAME } from '../shared/loopTurn';

export const APP_LOOP_DIR_SEGMENTS = ['.agent-terminal', 'loop'] as const;

export const APP_DONE_REL_PATH = [...APP_LOOP_DIR_SEGMENTS, TURN_DONE_FILENAME].join('/');

export const ARTIFACTS_SUBDIR = 'artifacts';

export const LOOP_OVERRIDE_FILE = '.agent-loop.yaml';
export const LOOP_OVERRIDE_MAP_KEY = 'loops';

export function loopDefRelPath(name: string): string {
  return `${name}/${name}.yaml`;
}
