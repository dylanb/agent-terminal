export const APP_LOOP_DIR_SEGMENTS = ['.agent-terminal', 'loop'] as const;

export const ARTIFACTS_SUBDIR = 'artifacts';

/** Whether a tree entry named `name` is the loop area's segment at `depth` on a filesystem that folds case or
 *  Unicode form, as the default macOS and Windows ones do. */
export function namesAppLoopSegment(name: string, depth: 0 | 1): boolean {
  return name.normalize('NFC').toLowerCase() === APP_LOOP_DIR_SEGMENTS[depth];
}
