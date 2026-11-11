import { TURN_DONE_FILENAME } from '../shared/loopTurn';
import { readBoundedNoFollow, readBoundedResolved, type BoundedRead } from './boundedRead';

export const APP_LOOP_DIR_SEGMENTS = ['.agent-terminal', 'loop'] as const;

export const APP_DONE_REL_PATH = [...APP_LOOP_DIR_SEGMENTS, TURN_DONE_FILENAME].join('/');

export const ARTIFACTS_SUBDIR = 'artifacts';

/** Whether a tree entry named `name` is the loop area's segment at `depth` on a filesystem that folds case or
 *  Unicode form, as the default macOS and Windows ones do. */
export function namesAppLoopSegment(name: string, depth: 0 | 1): boolean {
  return name.normalize('NFC').toLowerCase() === APP_LOOP_DIR_SEGMENTS[depth];
}

export const MAX_LOOP_ARTIFACT_BYTES = 16 * 1024 * 1024;

export const LOOP_OVERRIDE_FILE = '.agent-loop.yaml';
export const LOOP_OVERRIDE_MAP_KEY = 'loops';

export function loopDefRelPath(name: string): string {
  return `${name}/${name}.yaml`;
}

const textOf = (read: BoundedRead): string | null => (read.ok ? read.text : null);

export function readLoopArtifact(file: string): string | null {
  return textOf(readBoundedNoFollow(file, MAX_LOOP_ARTIFACT_BYTES));
}

/** An agent may name a link, which is followed. */
export function readNamedLoopArtifact(file: string): string | null {
  return textOf(readBoundedResolved(file, MAX_LOOP_ARTIFACT_BYTES));
}
