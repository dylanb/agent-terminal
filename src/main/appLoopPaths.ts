import { TURN_DONE_FILENAME } from '../shared/loopTurn';
import { readBoundedNoFollow, readBoundedResolved, type BoundedRead } from './boundedRead';

export const APP_LOOP_DIR_SEGMENTS = ['.agent-terminal', 'loop'] as const;

export const APP_DONE_REL_PATH = [...APP_LOOP_DIR_SEGMENTS, TURN_DONE_FILENAME].join('/');

export const ARTIFACTS_SUBDIR = 'artifacts';

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
